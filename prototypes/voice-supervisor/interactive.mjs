import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PlaybackQueue } from './playback.mjs';
import { quickReply } from './front.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
const model = process.env.VOICE_MODEL ?? 'deepseek-flash';
const runDir = join(here, '.runs', 'interactive-' + new Date().toISOString().replaceAll(':', '-'));
const fixture = join(runDir, 'workspace');
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'sample.txt'), 'voice-supervisor-reusable-fixture\n');
writeFileSync(join(fixture, 'worker-task.mjs'), "import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{setTimeout as wait}from'node:timers/promises';await wait(22000);const b=readFileSync('sample.txt');const r={sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length};writeFileSync('worker-result.json',JSON.stringify(r));console.log(JSON.stringify(r));\n");
const token = randomUUID(), uiToken = randomUUID(), readyFile = join(runDir, 'ready.json');
const env = { ...process.env, DSH_HOME: join(runDir, 'home'), DSH_PERMISSION_MODE: 'danger-full-access',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic', DSH_TELEMETRY_MODE: 'DISABLED', VOICE_MODEL: model,
  VOICE_LAB_TOKEN: token, VOICE_LAB_READY_FILE: readyFile.replaceAll('\\', '/'), VOICE_LAB_CWD: fixture.replaceAll('\\', '/') };
for (const name of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(name)) delete env[name];
const patch = join(runDir, 'overlay.yml');
writeFileSync(patch, readFileSync(join(here, 'overlay.yml'), 'utf8').replace('name: ./plugin.mjs', 'name: ' + JSON.stringify(join(here, 'plugin.mjs').replaceAll('\\', '/'))));
const log = createWriteStream(join(runDir, 'harness.log'));
const harness = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch,
  '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
harness.stdout.pipe(log); harness.stderr.pipe(log);
let exited = false, port, sessionId, cursor = 0, polling = false, current = null, pendingDelivery = null;
const player = new PlaybackQueue({ charsPerSecond: 9 });
const messages = [], metrics = [], turnEpochs = new Map();
let nativeState = {}, lastError = '', configured = false, activeNativeTurn;
function message(role, text) { messages.push({ role, text, at: Date.now() }); }
harness.on('exit', (code, signal) => { exited = true; lastError = `Harness stopped (${code ?? signal})`; });
async function api(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data;
}
const deadline = Date.now() + 90000;
while (!existsSync(readyFile)) {
  if (exited || Date.now() > deadline) throw new Error(lastError || 'Harness startup timeout');
  await delay(100);
}
({ port, sessionId } = JSON.parse(readFileSync(readyFile, 'utf8')));
let lastTick = performance.now();
const timer = setInterval(() => { const now = performance.now(); player.advance(now - lastTick); lastTick = now; }, 25);
const poller = setInterval(async () => {
  if (polling || exited) return; polling = true;
  try {
    const batch = await api(`/events?after=${cursor}`); cursor = batch.sequence;
    for (const e of batch.events) {
      if (e.type === 'child.started') message('任务', '子任务已启动：' + e.data.id);
      if (e.type === 'child.ended') message('任务', '子任务已结束：' + e.data.id);
      if (e.type !== 'session' || e.data.sessionId !== sessionId) continue;
      const event = e.data.event;
      if (event.type === 'turn/start') {
        activeNativeTurn = event.data.turn;
        if (current) turnEpochs.set(activeNativeTurn, { ...current });
      }
      if (event.type === 'user/message' && event.data.source?.rpcId === current?.id) {
        turnEpochs.set(activeNativeTurn, { ...current });
      }
      if (event.type !== 'assistant/message') continue;
      const text = (event.data.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
      if (!text) continue;
      const owner = turnEpochs.get(activeNativeTurn);
      message('调度器', text);
      if (owner) player.offer({ turnId: owner.id, role: 'answer', text, epoch: owner.epoch });
    }
    nativeState = await api('/state');
  } catch (error) { lastError = error.message; }
  finally { polling = false; }
}, 150);
function interrupt() {
  pendingDelivery = player.interrupt();
  message('打断', '虚拟播放已停止。下次发送将携带已播／未播回执；后台任务继续运行。');
  return pendingDelivery;
}
async function sendInput(text) {
  if (current && !pendingDelivery) interrupt();
  const delivery = pendingDelivery; pendingDelivery = null;
  const id = randomUUID(), epoch = player.begin(id);
  current = { id, epoch }; message('你', text);
  const start = performance.now();
  const front = quickReply({ key: process.env.DEEPSEEK_API_KEY, model, text, signal: AbortSignal.timeout(20000) })
    .then(result => { metrics.push({ firstTokenMs: result.firstTokenMs, completeMs: result.completeMs });
      message('快速接话', result.text); player.offer({ turnId: id, role: 'intro', text: result.text, epoch }); })
    .catch(error => { player.failIntro(id); message('错误', '接话模型：' + error.message); });
  const instructions = configured ? '' : `你是语音主调度器，最高优先级是响应用户。所有实际工作委派原生subagent子任务，自己不执行命令、不改文件。创建后立即简短回答，不调用wait_agents。子任务运行时继续响应用户，完成后主动报告真实结果。输出面向用户的简短中文。用户说停止或暂停任务时，调用原生subagent中断相应任务，并如实报告状态。工作目录是 ${fixture.replaceAll('\\', '/')}。样例任务可委派子任务用pwsh执行 node worker-task.mjs，它等待22秒后校验sample.txt，生成worker-result.json；不得修改此目录外文件。下方播放回执的已播放内容不等于用户已经理解。\n\n用户：`;
  configured = true;
  try { await api('/prompt', { requestId: id, text: instructions + text, delivery });
    metrics.push({ promptAcceptedMs: performance.now() - start }); }
  catch (error) { message('错误', '调度器：' + error.message); }
  await front;
}
let busy = false;
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
    if (req.method === 'GET' && url.pathname === '/state') return respond(200, { messages, metrics, delivery: player.delivery(),
      playing: player.playing?.id, nativeState, lastError, alive: !exited, busy, workspace: fixture });
    if (req.method !== 'POST') return respond(404, { error: 'Not found' });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return respond(413, { error: 'Input too large' }); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (url.pathname === '/interrupt') return respond(200, interrupt());
    if (url.pathname === '/send') {
      if (busy) return respond(409, { error: '上一条输入仍在接收，请稍后再发；可以随时打断播放。' });
      if (exited) return respond(503, { error: lastError });
      if (typeof input.text !== 'string' || !input.text.trim()) return respond(400, { error: '请输入内容' });
      busy = true; void sendInput(input.text.trim()).catch(e => { lastError = e.message; }).finally(() => { busy = false; });
      return respond(202, { accepted: true });
    }
    if (url.pathname === '/interrupt-child') return respond(202, await api('/interrupt-child', { childId: input.childId }));
    return respond(404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) respond(500, { error: error.message }); else res.destroy(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const address = `http://127.0.0.1:${server.address().port}`;
writeFileSync(join(runDir, 'interactive-ready.json'), JSON.stringify({ url: address, pid: process.pid, runDir }));
console.log(JSON.stringify({ url: address, runDir }));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(poller);
  writeFileSync(join(runDir, 'interactive-result.json'), JSON.stringify({ messages, metrics, playback: player.delivery() }, null, 2));
  server.closeAllConnections(); server.close(); harness.kill('SIGINT');
  await delay(1500); if (!exited) harness.kill('SIGKILL'); process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
