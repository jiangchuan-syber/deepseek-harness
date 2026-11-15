/** Actual outer HTTP, parser, Python broker, Agent loop and executor; fake models only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const python = process.env.VOICE_CONTROL_TEST_PYTHON;
if (!python) throw new Error('Explicit isolated Python executable required');
const here = dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'voice-outer-control-report-'));
await mkdir(join(dir, 'server/data'), { recursive: true }); await mkdir(join(dir, 'run'));
const stateFile = join(dir, 'broker-state.json'), clientFile = join(dir, 'client.json');
const output = process.env.VOICE_CONTROL_REPORT_ONLY_OUT ?? join(dir, 'report.json');
const did = '123456789';
await writeFile(join(dir, 'server/data/xiaomi-tokens.json'), JSON.stringify([{ homes: [{ home_id: 'fixture-home-3625',
  devices: [{ model: 'yeelink.light.lamp27', did, localip: '127.0.0.1', token: 'synthetic-fixture-token' }] }] }]));
await writeFile(stateFile, JSON.stringify({ power: true, readDelayMs: 20 }));
const provider = { kind: 'miio-lamp', enabled: true, mode: 'execute', allowWrite: true, cooperativeControlReady: true,
  python, workspace: dir, fixture: stateFile, expectedLampHash: createHash('sha256').update(did).digest('hex').slice(0, 16),
  operationLimitMs: 200, startupTimeoutMs: 2000, closeTimeoutMs: 1000 };
const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-offline-fixture-never-sent', VOICE_MODEL: 'fixture-parent-model', VOICE_CONTROL_REAL_AGENT: '1',
  VOICE_OUTER_FIXTURE_ROOT: dir, VOICE_LAB_WORKSPACE_DIR: dir, VOICE_LAB_RESUME_DIR: join(dir, 'run'),
  VOICE_LAB_CLIENT_CONFIG: clientFile, VOICE_LAB_PORT: '0',
  VOICE_SIMPLE_CONTROL_CONFIG: JSON.stringify({ enabled: true, budgetMs: 2500, capacity: 1, provider }) };
const child = spawn(process.execPath, ['--import', 'tsx/esm', '--import',
  pathToFileURL(join(here, 'fixtures/outer-control-preload.mjs')).href, join(here, '../interactive.mjs')],
  { cwd: resolve(here, '../../..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '', childExit = false, client, failure;
for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { childLog += value; });
const exited = new Promise(done => child.once('exit', (code, signal) => { childExit = true; done({ code, signal }); }));
const boundary = async () => JSON.parse(await readFile(join(dir, 'native-boundary.json'), 'utf8'));
const broker = async () => JSON.parse(await readFile(stateFile, 'utf8'));
const waitFor = async (predicate, message) => {
  const deadline = performance.now() + 15000;
  while (!(await predicate())) {
    assert.ok(!childExit && performance.now() < deadline, message + '\n' + childLog); await delay(15);
  }
};
const api = async (path, body) => {
  const response = await fetch(client.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-lab-token': client.token }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, path + ' HTTP ' + response.status); return response.json();
};
try {
  await waitFor(async () => { try { client = JSON.parse(await readFile(clientFile, 'utf8')); return true; }
    catch { return false; } }, 'Owned outer fixture startup');
  const primer = await api('/send', { text: '关灯', source: 'esp32', voiceSessionId: 'fixture-primer-voice' });
  await waitFor(async () => (await api('/control-result?commandId=' + primer.requestId)).control?.status === 'verified',
    'Private Python broker must prepare and verify the primer');
  await writeFile(stateFile, JSON.stringify({ ...await broker(), afterWriteDelayMs: 400, readDelayMs: 400 }));
  const control = await api('/send', { text: '开灯', source: 'esp32', voiceSessionId: 'fixture-report-voice' });
  await waitFor(async () => (await api('/control-result?commandId=' + control.requestId)).control?.status === 'unknown',
    'Python timeout must settle unknown while Max remains busy');
  assert.equal((await broker()).writes, 2); assert.equal((await boundary()).steers, 0);
  // The ordinary user request is queued separately from the report-only job.
  const ordinary = await api('/send', { text: '处理这个公开研究目标', source: 'esp32', voiceSessionId: 'fixture-normal-voice' });
  await waitFor(async () => (await api('/state')).messages.some(message =>
    message.requestId === ordinary.requestId && message.role === '快速接话'), 'Ordinary quick response');
  await writeFile(join(dir, 'release-max'), 'fixture-only-explicit-barrier');
  await waitFor(async () => (await boundary()).toolExecutions.includes('fixture_normal_task'), 'Normal user tool ability restored');
  await waitFor(async () => (await api('/state')).messages.filter(message => message.role === '调度器').length === 2,
    'Both separate parent turns must complete through outer observation');
  const observed = await boundary(), final = await api('/state'), state = await broker();
  assert.equal(observed.steers, 2); assert.equal(state.writes, 2, 'Report-only model repeated the consumed control');
  assert.deepEqual(observed.toolExecutions, ['fixture_normal_task']);
  const reportRequest = observed.modelRequests.find(request => request.reportOnly && request.first);
  const userRequest = observed.modelRequests.find(request => !request.reportOnly && request.first);
  assert.deepEqual(reportRequest.tools, ['fixture_local_control']); // Own-scope declarations bypass restrict; execution must still deny.
  assert.deepEqual([...userRequest.tools].sort(), ['fixture_repeat_control', 'fixture_delegate', 'fixture_normal_task', 'fixture_local_control'].sort());
  assert.equal(observed.toolResults.length, 4);
  assert.ok(observed.toolResults.slice(0, 3).every(result => result.isError === true));
  assert.equal(observed.toolResults[3].isError, false);
  assert.equal(observed.publicNetworkAttempts, 0); assert.equal(observed.blockedSpawns, 0);
  assert.equal(observed.brokerLaunches, 1);
  assert.ok(!final.messages.some(message => message.role === '错误'));
  await writeFile(output, JSON.stringify({ status: 'PASS', requestIds: [control.requestId, ordinary.requestId],
    checks: { maxBusyReleasedNoControlReplay: true, reportGlobalToolHidden: true, reportOwnScopeToolDenied: true,
      reportDelegationDenied: true, ordinaryToolRestored: true }, observed, state,
    coverage: { actualOuterHttp: true, actualPluginParser: true, actualPythonBroker: true, actualAgentLoop: true,
      actualNativeToolExecutor: true, modelSemantics: false, nativeCordisBootstrap: false, realAppliance: false }, fixtureDirectory: dir }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', report: output }));
} catch (error) {
  failure = error;
  await writeFile(output + '.failure.json', JSON.stringify({ status: 'FAIL', error: error.message, childLog, fixtureDirectory: dir }, null, 2));
  throw error;
} finally {
  if (client && !childExit) { try { await api('/shutdown', {}); } catch { /* Owned exit is checked below. */ } }
  let forcedExit = false;
  const timeout = setTimeout(() => { forcedExit = true; child.kill(); }, 10000);
  const result = await exited; clearTimeout(timeout);
  if (!failure) { assert.equal(forcedExit, false, 'Owned fixture failed to close'); assert.equal(result.signal, null); assert.equal(result.code, 0, childLog); }
}
