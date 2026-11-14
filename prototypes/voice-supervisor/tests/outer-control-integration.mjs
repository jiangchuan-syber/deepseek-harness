/** Explicit cross-repository fixture. No production configuration or endpoint is used. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const bridge = process.env.VOICE_CONTROL_BRIDGE_SOURCE;
const python = process.env.VOICE_CONTROL_TEST_PYTHON;
if (!bridge || !python) throw new Error('Explicit isolated bridge source and Python executable required');
const dir = await mkdtemp(join(tmpdir(), 'voice-outer-control-'));
await mkdir(join(dir, 'server/data'), { recursive: true });
await mkdir(join(dir, 'run'));
const stateFile = join(dir, 'broker-state.json'), clientFile = join(dir, 'client.json');
const output = process.env.VOICE_CONTROL_OUTER_REPORT ? resolve(process.env.VOICE_CONTROL_OUTER_REPORT) : join(dir, 'result.json');
const did = '123456789';
await writeFile(join(dir, 'server/data/xiaomi-tokens.json'), JSON.stringify([{ homes: [{ home_id: randomUUID() + '3625',
  devices: [{ model: 'yeelink.light.lamp27', did, localip: '127.0.0.1', token: 'synthetic-fixture-token' }] }] }]));
await writeFile(stateFile, JSON.stringify({ power: true, readDelayMs: 20 }));
const provider = { kind: 'miio-lamp', enabled: true, mode: 'execute', allowWrite: true, cooperativeControlReady: true,
  python, workspace: dir, fixture: stateFile, expectedLampHash: createHash('sha256').update(did).digest('hex').slice(0, 16),
  operationLimitMs: 200, startupTimeoutMs: 2000, closeTimeoutMs: 1000 };
const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-offline-fixture-never-sent',
  VOICE_OUTER_FIXTURE_ROOT: dir, VOICE_LAB_WORKSPACE_DIR: dir, VOICE_LAB_RESUME_DIR: join(dir, 'run'),
  VOICE_LAB_CLIENT_CONFIG: clientFile, VOICE_LAB_PORT: '0',
  VOICE_SIMPLE_CONTROL_CONFIG: JSON.stringify({ enabled: true, budgetMs: 2500, capacity: 1, provider }) };
const child = spawn(process.execPath, ['--import', 'tsx/esm', '--import', pathToFileURL(join(here, 'fixtures/outer-control-preload.mjs')).href,
  join(here, '../interactive.mjs')], { cwd: resolve(here, '../../..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '', childExit = false;
for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { childLog += value; });
const exited = new Promise(done => child.once('exit', (code, signal) => { childExit = true; done({ code, signal }); }));
const controllers = [], sse = { speech: [], control: [] };
let client, primaryError;
const native = {};
const api = async (path, body) => {
  const r = await fetch(client.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-lab-token': client.token }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${path} HTTP ${r.status}`); return r.json();
};
async function subscribe(path, outputEvents, retries = 0) {
  const controller = new AbortController(); controllers.push(controller);
  const r = await fetch(client.url + path, { headers: { 'x-lab-token': client.token }, signal: controller.signal });
  assert.equal(r.status, 200);
  void (async () => {
    let buffer = ''; const decoder = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true }); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = event.split('\n').find(value => value.startsWith('data: '));
          if (line) outputEvents.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (retries < 1) {
        native.sseReconnects = (native.sseReconnects ?? 0) + 1;
        try { await subscribe(path.split('?')[0] + '?after=' + (outputEvents.at(-1)?.sequence ?? 0), outputEvents, retries + 1); }
        catch (failure) { native.sseError = failure.name; }
      } else native.sseError = error.name;
    }
  })();
}
try {
  const until = performance.now() + 15000;
  while (!client) {
    try { client = JSON.parse(await readFile(clientFile, 'utf8')); } catch { /* Owned startup only. */ }
    assert.ok(!childExit && performance.now() < until, childLog || 'Outer fixture startup timed out');
    if (!client) await delay(20);
  }
  await subscribe('/speech-events', sse.speech); await subscribe('/control-events', sse.control);
  const consume = async (reportFile, extra = []) => {
    const consumer = spawn(python, [join(here, 'fixtures/outer-control-consumer.py'), '--bridge', resolve(bridge),
      '--config', clientFile, '--output', reportFile, ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let consumerLog = ''; for (const stream of [consumer.stdout, consumer.stderr]) stream.on('data', value => { consumerLog += value; });
    const timer = setTimeout(() => consumer.kill(), 30000);
    const result = await new Promise(done => consumer.once('exit', (code, signal) => done({ code, signal })));
    clearTimeout(timer); assert.equal(result.code, 0, consumerLog);
    return JSON.parse(await readFile(reportFile, 'utf8'));
  };
  const report = await consume(output);
  const auth = await fetch(client.url + '/state', { headers: { 'x-lab-token': 'wrong-fixture-token' } });
  assert.equal(auth.status, 403);
  const invalid = await fetch(client.url + '/control-result?commandId=a&commandId=b', { headers: { 'x-lab-token': client.token } });
  assert.equal(invalid.status, 400);
  // The real private broker writes, then exceeds its operation budget. The
  // controller must preserve unknown; neither observation nor lookup may retry.
  const beforeUnknown = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...beforeUnknown, afterWriteDelayMs: 400, readDelayMs: 400 }));
  const unknown = await api('/send', { text: '关灯', source: 'esp32', voiceSessionId: 'public-outer-unknown' });
  const unknownUntil = performance.now() + 5000;
  let unknownFact;
  while (unknownFact?.status !== 'unknown') {
    unknownFact = (await api('/control-result?commandId=' + unknown.requestId)).control;
    if (unknownFact?.status === 'unknown') break;
    assert.ok(performance.now() < unknownUntil, 'Actual broker timeout did not settle unknown'); await delay(20);
  }
  assert.equal(unknownFact.writeAttempted, true); assert.equal(unknownFact.writeAcknowledged, false);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).writes, 3);
  await api('/control-result?commandId=' + unknown.requestId);
  await api('/control-result?commandId=' + unknown.requestId);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).writes, 3, 'Unknown inspection replayed a write');
  const afterUnknown = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...afterUnknown, afterWriteDelayMs: 0, readDelayMs: 20 }));
  const recovered = await consume(output + '.recovered.json', ['--after-unknown', unknown.requestId]);
  report.cases.push(...recovered.cases);
  const nativeClient = JSON.parse(await readFile(join(dir, 'native-client.private.json'), 'utf8'));
  const nativeState = async () => {
    const r = await fetch(nativeClient.url + '/state', { headers: { authorization: 'Bearer ' + nativeClient.token } });
    assert.equal(r.status, 200); return r.json();
  };
  const waitFor = async (predicate, message) => {
    const until = performance.now() + 6000;
    while (!(await predicate())) { assert.ok(performance.now() < until, message); await delay(10); }
  };
  // Delay only the event observer in this owned fixture, like a stalled outer
  // connection. Admission and source state use real HTTP, never injected DTOs.
  await writeFile(join(dir, 'hold-events'), 'fixture-only');
  await waitFor(async () => { try { await access(join(dir, 'events-held')); return true; } catch { return false; } }, 'Event observer did not pause');
  for (let i = 0; i < 32; i++) {
    await api('/send', { text: '公开普通研究目标' + i, source: 'esp32', voiceSessionId: 'ordinary-full-' + i });
    await waitFor(async () => (await nativeState()).queue.readyContinuations === i + 1, 'Actual ordinary handoffs did not fill');
  }
  const saturationBefore = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...saturationBefore, beforeWriteDelayMs: 150, readDelayMs: 150 }));
  const independent = await api('/send', { text: '关灯', source: 'esp32', voiceSessionId: 'public-outer-independent' });
  await waitFor(async () => (await nativeState()).controlStats.activeAdmissions === 1, 'Ordinary backlog rejected independent control');
  const overControl = await api('/send', { text: '开灯', source: 'esp32', voiceSessionId: 'public-outer-over-capacity' });
  const unsupported = await api('/send', { text: '开风扇', source: 'esp32', voiceSessionId: 'public-outer-unsupported' });
  const overOrdinary = await api('/send', { text: '又一个公开研究目标', source: 'esp32', voiceSessionId: 'public-outer-over-ordinary' });
  await waitFor(async () => (await nativeState()).controls.some(c => c.commandId === independent.requestId && c.status === 'verified'), 'Independent control did not finish');
  const saturated = await nativeState();
  assert.equal(saturated.queue.readyContinuations, 32); assert.equal(saturated.controlStats.activeAdmissions, 0);
  assert.equal(saturated.controlStats.retainedCommands, 5);
  await unlink(join(dir, 'hold-events'));
  await waitFor(async () => {
    const outer = await api('/state');
    return outer.controls.some(c => c.commandId === independent.requestId && c.status === 'verified')
      && [overControl, unsupported, overOrdinary].every(item => outer.messages.some(m => m.requestId === item.requestId && m.role === '错误'));
  }, 'Actual outer failure/state projection did not settle');
  await waitFor(async () => sse.control.some(e => e.commandId === independent.requestId && e.status === 'verified'), 'Control SSE cursor did not recover');
  const state = await api('/state'), trace = await api('/trace?after=0');
  const boundary = JSON.parse(await readFile(join(dir, 'native-boundary.json'), 'utf8'));
  const brokerState = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(brokerState.writes, 5); assert.equal(brokerState.power, false);
  assert.equal(boundary.launches, 1); assert.equal(boundary.brokerLaunches, 1);
  assert.equal(boundary.steers, 0); assert.equal(boundary.publicNetworkAttempts, 0); assert.equal(boundary.blockedSpawns, 0);
  assert.equal(boundary.quickRequests.length, 37);
  assert.ok(boundary.quickRequests.every(q => q.reasoningEffort === 'off' && !q.tools));
  assert.equal(boundary.injections.length, 5);
  assert.equal(state.nativeState.status, 'running');
  assert.equal(state.messages.filter(m => m.role === '调度器').length, 0);
  assert.equal(saturated.controls.length, 1); // Native admission snapshot limit.
  assert.ok(state.controls.length >= 1 && state.controls.length <= 256); // Live-event outer ring may lead the next poll.
  assert.equal(state.controlProjection.historyTruncated, true);
  for (const item of report.cases) {
    const matching = e => e.commandId === item.requestId && e.voiceSessionId === item.voiceSessionId;
    assert.ok(sse.control.some(e => matching(e) && e.status === 'verified'));
    assert.ok(sse.speech.some(e => e.kind === 'start' && e.requestId === item.requestId && e.voiceSessionId === item.voiceSessionId));
    assert.ok(trace.events.some(e => e.kind === 'control.verified' && e.requestId === item.requestId));
  }
  assert.equal(native.sseError, undefined);
  await writeFile(output, JSON.stringify({ ...report, negativeCases: { wrongAuth: 'PASS', invalidQuery: 'PASS',
    timeoutUnknownNoRewrite: 'PASS', oldFactNotRelabeledAsNewTurn: 'PASS', unknownFact,
    fullOrdinaryQueueIndependentControl: 'PASS', independentControlAdmissionStillBounded: 'PASS',
    unsupportedStillUsesOrdinaryLimit: 'PASS', ordinaryBacklog: saturated.queue.readyContinuations }, boundary, brokerState, sse,
    observation: { sseReconnects: native.sseReconnects ?? 0, replayUsesActualSequence: true },
    coverage: { actualOuterHttpSse: true, actualPluginAndPythonBroker: true, actualPythonBridgeAndFlow: true,
      nativeCordisBootstrap: false, modelSemantics: false, browserVisuals: false, physicalPttOrAcoustics: false },
    fixtureDirectory: dir }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', cases: report.cases.length, report: output, fixtureDirectory: dir }));
} catch (error) {
  primaryError = error;
  await writeFile(output + '.failure.json', JSON.stringify({ status: 'FAIL', error: error.message, childLog, fixtureDirectory: dir }, null, 2) + '\n');
  throw error;
} finally {
  try { await unlink(join(dir, 'hold-events')); } catch { /* File belongs only to this fixture. */ }
  for (const controller of controllers) controller.abort();
  if (client && !childExit) { try { await api('/shutdown', {}); } catch { /* Owned process exit below. */ } }
  const timeout = setTimeout(() => child.kill('SIGTERM'), 6000);
  const final = await exited; clearTimeout(timeout);
  if (!primaryError) assert.equal(final.code, 0, childLog);
}
