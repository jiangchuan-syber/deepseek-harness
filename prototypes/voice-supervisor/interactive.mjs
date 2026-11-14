import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PlaybackQueue } from './playback.mjs';
import { nativeTrace, traceState } from './trace.mjs';
import { SpeechEvents } from './speech-events.mjs';
import { runtimeHealth } from './health.mjs';
import { RotatingLog } from './rotating-log.mjs';
import { controlSnapshot, controlView } from './control-view.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
const model = process.env.VOICE_MODEL ?? 'deepseek-flash';
const runDir = process.env.VOICE_LAB_RESUME_DIR ?? join(here, '.runs', 'interactive-' + new Date().toISOString().replaceAll(':', '-'));
const fixture = process.env.VOICE_LAB_WORKSPACE_DIR ? resolve(process.env.VOICE_LAB_WORKSPACE_DIR) : join(runDir, 'workspace');
mkdirSync(fixture, { recursive: true });
if (!process.env.VOICE_LAB_WORKSPACE_DIR) {
  if (!existsSync(join(fixture, 'sample.txt'))) writeFileSync(join(fixture, 'sample.txt'), 'voice-supervisor-reusable-fixture\n');
  if (!existsSync(join(fixture, 'worker-task.mjs'))) writeFileSync(join(fixture, 'worker-task.mjs'), "import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{setTimeout as wait}from'node:timers/promises';await wait(22000);const b=readFileSync('sample.txt');const r={sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length};writeFileSync('worker-result.json',JSON.stringify(r));console.log(JSON.stringify(r));\n");
}
const token = randomUUID(), uiToken = randomUUID(), readyFile = join(runDir, 'ready-' + randomUUID() + '.json');
const env = { ...process.env, DSH_HOME: join(runDir, 'home'), DSH_PERMISSION_MODE: 'danger-full-access',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic', DSH_TELEMETRY_MODE: 'DISABLED', VOICE_MODEL: model,
  VOICE_LAB_TOKEN: token, VOICE_LAB_READY_FILE: readyFile.replaceAll('\\', '/'), VOICE_LAB_CWD: fixture.replaceAll('\\', '/') };
for (const name of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(name)) delete env[name];
const patch = join(runDir, 'overlay.yml');
writeFileSync(patch, readFileSync(join(here, 'overlay.yml'), 'utf8').replace('name: ./plugin.mjs', 'name: ' + JSON.stringify(join(here, 'plugin.mjs').replaceAll('\\', '/'))));
const log = new RotatingLog(join(runDir, 'harness.log'));
const harness = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch,
  '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const harnessExit = new Promise(done => harness.once('exit', done));
harness.stdout.pipe(log); harness.stderr.pipe(log);
let exited = false, runtimeStarted = false, port, sessionId, cursor = 0, polling = false, current = null, pendingDelivery = null;
const player = new PlaybackQueue({ charsPerSecond: 9 });
const messages = [], metrics = [], requests = new Map(), attempts = new Map();
const traces = [], childOwners = new Map();
const speechEvents = new SpeechEvents();
const controlEvents = new SpeechEvents();
let activeSpeechId;
let traceSequence = existsSync(join(runDir, 'trace.jsonl')) ? readFileSync(join(runDir, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).sequence).at(-1) ?? 0 : 0;
function trace(event, owner = current) {
  const item = { requestId: owner?.id, voiceSessionId: owner?.voiceSessionId, ...event, sequence: ++traceSequence };
  traces.push(item); if (traces.length > 2000) traces.shift();
  appendFileSync(join(runDir, 'trace.jsonl'), JSON.stringify(item) + '\n');
}
let nativeState = {}, lastError = '', lastNativePollAt = 0;
function continueDeep(owner) {
  void api('/continue', { requestId: owner?.id }).catch(error => {
    lastError = error.message;
    const text = '接话完成，但任务未能进入主调度，请检查调度服务。';
    trace({ at: Date.now(), kind: 'scheduler.error', actor: '主调度器', title: text }, owner);
    message('错误', text, owner);
  });
}
function message(role, text, owner = current, extra = {}) { const item = { role, text, at: Date.now(), requestId: owner?.id ?? owner?.requestId, ...extra }; messages.push(item); appendFileSync(join(runDir, 'speech-outbox.jsonl'), JSON.stringify(item) + '\n'); }
harness.on('exit', (code, signal) => {
  exited = true; lastError = `Harness stopped (${code ?? signal})`; speechEvents.close(); controlEvents.close();
  if (runtimeStarted) void shutdown(1);
});
async function api(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data;
}
const deadline = Date.now() + 90000;
while (!existsSync(readyFile)) {
  if (exited || Date.now() > deadline) {
    await stopHarness();
    throw new Error(lastError || 'Harness startup timeout; inspect the private run log');
  }
  await delay(100);
}
({ port, sessionId } = JSON.parse(readFileSync(readyFile, 'utf8')));
writeFileSync(join(runDir, 'runtime-session.local.json'), JSON.stringify({ sessionId, workspace: fixture }));
let lastTick = performance.now();
const timer = setInterval(() => { const now = performance.now(); player.advance(now - lastTick); lastTick = now; }, 25);
const poller = setInterval(async () => {
  if (polling || exited) return; polling = true;
  try {
    const batch = await api(`/events?after=${cursor}`); cursor = batch.sequence;
    for (const e of batch.events) {
      const suppliedOwner = e.data?.owner;
      const eventOwner = suppliedOwner ? requests.get(suppliedOwner.requestId) ?? { id: suppliedOwner.requestId, voiceSessionId: suppliedOwner.voiceSessionId } : current;
      if (e.type === 'control.state') {
        const fact = controlView(e.data);
        if (!fact) continue;
        const controlOwner = requests.get(e.data.commandId) ?? { id: e.data.commandId, voiceSessionId: e.data.voiceSessionId };
        controlEvents.push({ ...fact, kind: 'control.state', at: e.time });
        nativeState.controls = [...(nativeState.controls ?? []).filter(item => item.commandId !== fact.commandId), fact].slice(-256);
        trace({ at: e.time, kind: 'control.' + fact.status, actor: '程序控制', title: '设备控制状态', details: fact }, controlOwner);
      }
      if (e.type === 'stage' || e.type === 'phase') {
        trace({ at: e.time, kind: e.type === 'stage' && e.data.kind === 'input.queued' ? 'input.queued' : 'scheduler.phase',
          actor: '主调度器', title: e.type === 'phase' ? '主调度阶段更新' : '输入队列更新', details: e.data },
          requests.get(e.data.job?.requestId) ?? eventOwner);
      }
      if (e.type === 'model.started') {
        if (e.data.lane !== 'quick') {
          if (activeSpeechId) speechEvents.push({ kind: 'abort', outputId: activeSpeechId });
          activeSpeechId = e.data.attemptId;
        }
        speechEvents.push({ kind: 'start', outputId: e.data.attemptId, phase: e.data.phase,
          requestId: eventOwner?.id, voiceSessionId: eventOwner?.voiceSessionId, at: e.time });
        attempts.set(e.data.attemptId, { started: e.time, phase: e.data.phase });
        trace({ at: e.time, kind: e.data.phase === 'quick' ? 'front.request' : 'scheduler.request', actor: '主调度器',
          title: e.data.phase === 'quick' ? '同一主调度快速回应' : '正在思考中',
          details: { model, reasoningEffort: e.data.reasoningEffort, thinking: e.data.reasoningEffort === 'off' ? 'disabled' : 'enabled',
            attemptId: e.data.attemptId, preparationMs: e.data.preparationMs, acceptedToStartMs: e.data.acceptedToStartMs,
            historyChars: e.data.historyChars, inputChars: e.data.inputChars, systemChars: e.data.systemChars,
            maxTokens: e.data.maxTokens, toolCount: e.data.toolCount } }, eventOwner);
      }
      if (e.type === 'speech.delta') speechEvents.push({ kind: 'delta', outputId: e.data.attemptId,
        text: e.data.text, at: e.time });
      if (e.type === 'model.delta') {
        const timing = attempts.get(e.data.attemptId);
        if (timing) { timing.firstTokenMs ??= e.data.elapsedMs ?? e.data.time - timing.started;
          if (e.data.category === 'text-delta') timing.firstTextMs ??= e.data.elapsedMs ?? e.data.time - timing.started; }
        trace({ at: e.time, kind: 'scheduler.token', actor: '主调度器', title: '收到模型首增量',
          details: { category: e.data.category, ...timing } }, eventOwner);
      }
      if (e.type === 'quick.completed') {
        speechEvents.push({ kind: 'end', outputId: e.data.attemptId, text: e.data.text,
          messageId: e.data.messageId, at: e.time });
        const timing = attempts.get(e.data.attemptId);
        trace({ at: e.time, kind: 'front.reply', actor: '快速接话', title: '独立短上下文快速回应', text: e.data.text,
          messageId: e.data.messageId, details: { model, sameSession: false, firstTokenMs: timing?.firstTextMs,
            completeMs: e.data.completeMs } }, eventOwner);
        message('快速接话', e.data.text, eventOwner, { messageId: e.data.messageId, phase: 'quick' });
        if (eventOwner?.epoch === player.epoch) player.offer({ turnId: eventOwner.id, role: 'intro', text: e.data.text, epoch: eventOwner.epoch });
        trace({ at: Date.now(), kind: 'front.forwarded', actor: '快速接话', title: '接话已转发语音通道，放行深度续接', details: { forwardDelayMs: Date.now() - e.time } }, eventOwner);
        if (!e.data.owner?.controlHandled) continueDeep(eventOwner);
      }
      if (e.type === 'quick.aborted') speechEvents.push({ kind: 'abort', outputId: e.data.attemptId });
      if (e.type === 'quick.failed' || e.type === 'quick.continuation_failed') {
        const text = e.type === 'quick.failed' ? '快速接话失败，主调度继续处理。' : '任务未能进入主调度队列，请检查运行日志。';
        trace({ at: e.time, kind: 'front.error', actor: '快速接话', title: text, details: { errorType: e.data.errorType } }, eventOwner);
        message('错误', text, eventOwner);
        if (e.type === 'quick.failed' && !e.data.owner?.controlHandled) continueDeep(eventOwner);
      }
      if (e.type === 'child.started') childOwners.set(e.data.id, eventOwner);
      const projected = nativeTrace(e, sessionId);
      if (projected) {
        if (projected.kind === 'front.reply') {
          const timing = [...attempts.values()].filter(item => item.phase === 'quick').at(-1);
          projected.details = { model, sameSession: true, firstTokenMs: timing?.firstTextMs,
            completeMs: timing ? e.time - timing.started : undefined };
        }
        trace(projected, projected.childId ? childOwners.get(projected.childId) ?? eventOwner : eventOwner);
      }
      if (e.type === 'stage' && e.data.kind === 'phase.error') message('错误', '调度阶段失败：' + e.data.error, requests.get(e.data.job.requestId));
      if (e.type !== 'session' || e.data.sessionId !== sessionId || e.data.event.type !== 'assistant/message') continue;
      const event = e.data.event;
      const text = (event.data.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
      if (activeSpeechId) {
        speechEvents.push({ kind: 'end', outputId: activeSpeechId, text, messageId: event.data.message.id, at: e.time });
        activeSpeechId = undefined;
      }
      if (!text || text === '无需补充') continue;
      const quick = e.data.phase === 'quick';
      message(quick ? '快速接话' : '调度器', text, eventOwner, { messageId: event.data.message.id, phase: quick ? 'quick' : 'thinking' });
      if (eventOwner?.epoch === player.epoch) player.offer({ turnId: eventOwner.id, role: quick ? 'intro' : 'answer', text, epoch: eventOwner.epoch });
    }
    nativeState = await api('/state');
    lastNativePollAt = performance.now();
  } catch (error) { lastError = error.message; }
  finally { polling = false; }
}, 50);
function interrupt() {
  pendingDelivery = player.interrupt();
  message('打断', '虚拟播放已停止。下次发送将携带已播／未播回执；后台任务继续运行。');
  return pendingDelivery;
}
async function sendInput(text, id, deviceDelivery, source, voiceSessionId) {
  if (current && !pendingDelivery) interrupt();
  // A real device must never inherit the virtual player's delivery estimate.
  const delivery = source === 'esp32' ? deviceDelivery : pendingDelivery; pendingDelivery = null;
  const epoch = player.begin(id);
  current = { id, epoch, voiceSessionId }; message('你', text);
  trace({ at: Date.now(), kind: 'input.accepted', actor: source === 'esp32' ? 'ESP32 → 调度入口' : '网页输入', title: '文字输入已接收', text,
    details: { source, delivery } });
  requests.set(id, { id, epoch, voiceSessionId });
  try { await api('/prompt', { requestId: id, text, delivery, voiceSessionId, acceptedAt: Date.now() }); }
  catch (error) { message('错误', '调度器：' + error.message, { id }); }

}
let busy = 0;
const server = createServer(async (req, res) => {
  const respond = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
  try {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return respond(403, { error: 'Invalid host' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return respond(403, { error: 'Invalid origin' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') return respond(200, readFileSync(join(here, 'interactive.html'), 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return respond(200, readFileSync(join(here, 'interactive-ui.js'), 'utf8').replace('__TOKEN__', uiToken), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.css') return respond(200, readFileSync(join(here, 'interactive.css'), 'utf8'), 'text/css; charset=utf-8');
    if (req.headers['x-lab-token'] !== uiToken) return respond(403, { error: 'Forbidden' });
    if (req.method === 'GET' && ['/health/live', '/health/ready'].includes(url.pathname)) {
      const health = runtimeHealth({ exited, stopping, lastPollAt: lastNativePollAt });
      return respond(health[url.pathname.endsWith('ready') ? 'ready' : 'live'] ? 200 : 503, health);
    }
    if (req.method === 'GET' && url.pathname === '/trace') {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) return respond(400, { error: 'Invalid cursor' });
      return respond(200, { events: traces.filter(item => item.sequence > after), sequence: traceSequence,
        state: traceState(nativeState),
        gap: traces.length > 0 && after > 0 && after < traces[0].sequence - 1 });
    }
    if (req.method === 'GET' && url.pathname === '/speech-events') return speechEvents.subscribe(Number(url.searchParams.get('after') ?? 0), res);
    if (req.method === 'GET' && url.pathname === '/control-events') return controlEvents.subscribe(Number(url.searchParams.get('after') ?? 0), res);
    if (req.method === 'GET' && url.pathname === '/state') return respond(200, { messages, metrics, speechProtocol: 2, speechSequence: speechEvents.sequence, delivery: player.delivery(),
      playing: player.playing?.id, ...controlSnapshot(nativeState), nativeState, lastError, alive: !exited, busy: busy > 0, workspace: fixture });
    if (req.method !== 'POST') return respond(404, { error: 'Not found' });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return respond(413, { error: 'Input too large' }); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (url.pathname === '/quick-probe') { respond(200, await api('/quick-probe', {})); return; }
    if (url.pathname === '/shutdown') { respond(202, { accepted: true }); void shutdown(); return; }
    if (url.pathname === '/delivery') {
      const receipt = await api('/delivery', input);
      appendFileSync(join(runDir, 'speech-outbox.jsonl'), JSON.stringify({ at: Date.now(), type: 'device-completed', ...input }) + '\n');
      return respond(200, receipt);
    }
    if (url.pathname === '/interrupt') return respond(200, interrupt());
    if (url.pathname === '/send') {
      if (exited) return respond(503, { error: lastError });
      if (typeof input.text !== 'string' || !input.text.trim()) return respond(400, { error: '请输入内容' });
      const requestId = randomUUID(), messageCursor = messages.length;
      busy++; void sendInput(input.text.trim(), requestId, input.delivery, input.source, input.voiceSessionId).catch(e => { lastError = e.message; }).finally(() => { busy--; });
      return respond(202, { accepted: true, requestId, messageCursor });
    }
    if (url.pathname === '/interrupt-child') return respond(202, await api('/interrupt-child', { childId: input.childId }));
    return respond(404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) respond(500, { error: error.message }); else res.destroy(); }
});
await new Promise(done => server.listen(Number(process.env.VOICE_LAB_PORT ?? 0), '127.0.0.1', done));
const address = `http://127.0.0.1:${server.address().port}`;
writeFileSync(join(runDir, 'interactive-ready.json'), JSON.stringify({ url: address, pid: process.pid, runDir }));
if (process.env.VOICE_LAB_CLIENT_CONFIG) writeFileSync(process.env.VOICE_LAB_CLIENT_CONFIG,
  JSON.stringify({ url: address, token: uiToken, runDir }));
console.log(JSON.stringify({ url: address, runDir }));
let stopping = false;
runtimeStarted = true;
if (exited) void shutdown(1);
async function shutdown(exitCode = 0) {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(poller);
  writeFileSync(join(runDir, 'interactive-result.json'), JSON.stringify({ messages, metrics, playback: player.delivery() }, null, 2));
  speechEvents.close(); controlEvents.close();
  server.closeAllConnections(); server.close();
  await stopHarness();
  process.exit(exitCode);
}
async function stopHarness() {
  if (!exited) harness.kill('SIGINT');
  await Promise.race([harnessExit, delay(5000)]);
  if (!exited) harness.kill('SIGKILL');
  await harnessExit;
  await new Promise(done => log.end(done));
}
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
