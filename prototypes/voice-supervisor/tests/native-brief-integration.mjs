/** One true CLI/Cordis structure case against a synthetic loopback Messages server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
const root = await mkdtemp(join(tmpdir(), 'voice-native-brief-'));
await mkdir(join(root, 'home')); await mkdir(join(root, 'workspace'));
const key = 'synthetic-native-fixture-key', marker = 'PUBLIC_NATIVE_CHILD_PROMPT_731';
const brief = 'PUBLIC_NATIVE_CHILD_BRIEF_731: synthetic structural result; not independently verified.';
const rewritten = '主调度结构汇总：已收到公开子任务结果，真实效果尚未验证。';
const report = { status: 'NOT_RUN', nativePluginReady: false, nativeCliStarted: false, requests: [],
  coverage: { fullNativeCli: 'NOT_RUN', childAgentInSameProcess: true, osChildTaskIsolation: false,
    realModelSemanticQuality: 'NOT_RUN', acoustic: 'NOT_RUN', productionChanged: false } };
const destination = process.env.VOICE_NATIVE_REPORT ?? join(root, 'report.json');
let dispatched = false, childAnswers = 0, rewrites = 0, secretHeaderRejected = false;
function sse(block, stop = 'end_turn') {
  const start = { type: 'message_start', message: { id: 'fixture-' + randomUUID(), model: 'deepseek-flash',
    usage: { input_tokens: 20, output_tokens: 0 } } };
  const events = [start, { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 20 } }, { type: 'message_stop' }];
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
const texts = body => (body.messages ?? []).flatMap(m => (m.content ?? []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
const provider = createServer((req, res) => {
  void (async () => {
    if ((req.headers.authorization && req.headers.authorization !== 'Bearer ' + key) || req.headers['x-api-key'] !== key) {
      secretHeaderRejected = true; res.writeHead(403); res.end(); return; // Never record credential values.
    }
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/anthropic/v1/messages');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 2_000_000); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const quick = JSON.stringify(body.system).includes('近期对话仅作背景');
    const content = texts(body), child = content.includes(marker), hasBrief = JSON.stringify(body.messages).includes(brief);
    report.requests.push({ quick, child, hasBrief, tools: body.tools?.map(t => t.name) ?? [], messages: body.messages });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (quick) return res.end(sse({ type: 'text', text: '好的，我来处理。' }));
    if (child) { childAnswers++; return res.end(sse({ type: 'text', text: brief })); }
    if (hasBrief) { rewrites++; return res.end(sse({ type: 'text', text: rewritten })); }
    if (!dispatched) {
      assert.ok(body.tools?.some(t => t.name === 'subagent'), 'Actual native subagent tool is not exposed; stop rather than guessing another executor');
      dispatched = true;
      return res.end(sse({ type: 'tool_use', id: 'fixture-call-731', name: 'subagent',
        input: { description: 'Public structure check', prompt: marker + ': return a short public test brief; no tools or side effects.' } }, 'tool_use'));
    }
    return res.end(sse({ type: 'text', text: '无需补充' }));
  })().catch(error => { report.providerError = { name: error.name, message: error.message }; res.destroy(); });
});
await new Promise(done => provider.listen(0, '127.0.0.1', done));
const port = provider.address().port;
const require = createRequire(import.meta.url), tsxRequire = createRequire(require.resolve('tsx/package.json'));
const esRequire = createRequire(tsxRequire.resolve('esbuild/package.json'));
const esbuild = esRequire.resolve('@esbuild/win32-x64/esbuild.exe');
const cliRequire = createRequire(join(repo, 'apps/cli/package.json'));
const subprocessSource = cliRequire.resolve('@deepseek-ai/dsh-subprocess-local/src/index.ts');
assert.equal(resolve(subprocessSource), join(repo, 'packages/subprocess/subprocess-local/src/index.ts'));
const ready = join(root, 'ready.json'), token = randomUUID();
let overlay = (await readFile(join(here, '../overlay.yml'), 'utf8'))
  .replace('name: ./plugin.mjs', 'name: ' + JSON.stringify(resolve(here, '../plugin.mjs').replaceAll('\\', '/')))
  .replace('    reasoningEffort: high', `    reasoningEffort: high\n    baseURL: http://127.0.0.1:${port}/anthropic\n    models:\n      - id: deepseek-flash\n        contextWindow: 128000\n        maxTokens: 4096`);
overlay += `\n- id: tool-subagent\n  config:\n    provider: spawn\n    toolName: subagent\n    maxDepth: 1\n- insert:\n    - id: native-brief-fixture-policy\n      name: ${JSON.stringify(join(here, 'fixtures/native-brief-policy.mjs').replaceAll('\\', '/'))}\n`;
const patch = join(root, 'overlay.yml'); await writeFile(patch, overlay);
const allowed = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'userprofile', 'localappdata']);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())));
Object.assign(env, { DEEPSEEK_API_KEY: key, VOICE_MODEL: 'deepseek-flash', DSH_HOME: join(root, 'home'),
  DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'read-only', VOICE_LAB_TOKEN: token,
  VOICE_LAB_READY_FILE: ready, VOICE_LAB_CWD: join(root, 'workspace'), VOICE_LAB_WORKSPACE_DIR: join(root, 'workspace'),
  VOICE_NATIVE_FIXTURE_ROOT: root, VOICE_NATIVE_PROVIDER_PORT: String(port), VOICE_NATIVE_ESBUILD: esbuild,
  TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), VOICE_NATIVE_SUBPROCESS_MODULE: pathToFileURL(subprocessSource).href,
  VOICE_NATIVE_ESBUILD_SHA: createHash('sha256').update(await readFile(esbuild)).digest('hex') });
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--import', pathToFileURL(join(here, 'fixtures/native-brief-guard.mjs')).href,
  join(repo, 'apps/cli/src/bin.ts'), '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
{ cwd: join(root, 'workspace'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', ended = false;
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
const exit = new Promise(done => child.once('exit', (code, signal) => { ended = true; done({ code, signal }); }));
report.ownedPid = child.pid;
try {
  const deadline = performance.now() + 60000; let config;
  while (!config) {
    try { config = JSON.parse(await readFile(ready, 'utf8')); } catch { /* Owned startup. */ }
    assert.ok(!ended && performance.now() < deadline, 'Native startup failed; inspect retained fixture log');
    if (!config) await delay(25);
  }
  report.nativePluginReady = true;
  let launcherReady;
  while (!launcherReady) {
    try { launcherReady = JSON.parse(await readFile(join(root, 'native-app-ready.json'), 'utf8')); } catch { /* Actual boot commit, not a timer. */ }
    assert.ok(!ended && performance.now() < deadline, 'Full profile startup failed or did not commit launcher readiness');
    if (!launcherReady) await delay(25);
  }
  assert.equal(launcherReady.launcherCommitted, true);
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(r.ok, `${path} status${r.status}`); return r.json();
  };
  const requestId = randomUUID();
  await api('/state');
  report.nativeCliStarted = true;
  report.coverage.fullNativeCli = 'PASS';
  await api('/prompt', { requestId, voiceSessionId: 'public-native-voice', text: '检查公开子任务结构并汇总结果。' });
  let continued = false, events = [];
  while (performance.now() < deadline) {
    events = (await api('/events?after=0')).events;
    if (!continued && events.some(e => e.type === 'quick.completed')) { await api('/continue', { requestId }); continued = true; }
    if (events.some(e => e.type === 'session' && e.data.event.type === 'assistant/message'
        && JSON.stringify(e.data.event.data).includes(rewritten))) break;
    if (report.providerError) throw new Error(report.providerError.message);
    await delay(25);
  }
  assert.ok(dispatched && childAnswers >= 1 && rewrites >= 1, 'Actual child/inbox/parent second generation not proven');
  assert.ok(events.some(e => e.type === 'child.started') && events.some(e => e.type === 'child.ended'));
  assert.ok(events.some(e => e.type === 'session' && ['agent-message', 'subagent-settled'].includes(e.data.event.data?.source?.kind)), 'Actual parent did not receive a child notice');
  assert.equal(secretHeaderRejected, false); report.events = events; report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = { name: error.name, message: error.message }; }
finally {
  if (!ended) child.kill('SIGINT');
  report.exit = await Promise.race([exit, delay(5000).then(() => ({ pending: true }))]);
  if (!ended) { child.kill('SIGKILL'); report.forcedStop = true; report.exit = await exit; }
  await writeFile(join(root, 'native-cli.log'), log);
  try { report.fence = JSON.parse(await readFile(join(root, 'fence.json'), 'utf8')); } catch { report.fence = null; }
  report.structuralStatus = report.status;
  report.guardStatus = report.fence && report.fence.unknownSpawn.length === 0
    && report.fence.deniedNetwork === 0 && report.fence.subprocessDenied === 0 ? 'PASS' : 'FAIL';
  if (report.guardStatus !== 'PASS') report.status = 'FAIL';
  report.fixtureDirectory = root;
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  await new Promise(done => provider.close(done));
}
console.log(JSON.stringify({ status: report.status, structuralStatus: report.structuralStatus, guardStatus: report.guardStatus,
  nativeCliStarted: report.nativeCliStarted, requests: report.requests.length,
  fixtureDirectory: root, report: destination, error: report.error, fence: report.fence }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
