import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PlaybackQueue } from './playback.mjs';
import { quickReply } from './front.mjs';
import { answerPhase } from './events.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('Set DEEPSEEK_API_KEY before running');
const model = process.env.VOICE_MODEL ?? 'deepseek-flash';
const runDir = resolve(process.env.VOICE_RUN_DIR ?? join(here, '.runs', new Date().toISOString().replaceAll(':', '-')));
const fixture = join(runDir, 'workspace'); mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, 'sample.txt'), 'voice-supervisor-reusable-fixture\n');
writeFileSync(join(fixture, 'worker-task.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';import{createHash}from'node:crypto';import{setTimeout as wait}from'node:timers/promises';await wait(22000);const data=readFileSync('sample.txt');const result={sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};writeFileSync('worker-result.json',JSON.stringify(result));console.log(JSON.stringify(result));\n`);
const token = randomUUID(), readyFile = join(runDir, 'ready.json');
const env = { ...process.env, DSH_HOME: join(runDir, 'home'), DSH_PERMISSION_MODE: 'danger-full-access',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic', DSH_TELEMETRY_MODE: 'DISABLED', VOICE_MODEL: model,
  VOICE_LAB_PLUGIN: join(here, 'plugin.mjs').replaceAll('\\', '/'), VOICE_LAB_TOKEN: token,
  VOICE_LAB_READY_FILE: readyFile.replaceAll('\\', '/'), VOICE_LAB_CWD: fixture.replaceAll('\\', '/') };
for (const name of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(name)) delete env[name];
const overlayFile = join(runDir, 'overlay.yml');
writeFileSync(overlayFile, readFileSync(join(here, 'overlay.yml'), 'utf8').replace('name: ./plugin.mjs',
  'name: ' + JSON.stringify(env.VOICE_LAB_PLUGIN)));
const output = createWriteStream(join(runDir, 'harness.log'));
const harness = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web',
  '--patch', overlayFile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
{ cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
harness.stdout.pipe(output, { end: false }); harness.stderr.pipe(output, { end: false });
let exitInfo = null;
const exited = new Promise(done => harness.once('exit', (code, signal) => { exitInfo = { code, signal }; done(exitInfo); }));
let poller, ticker, polling = false, port, sessionId, cursor = 0;
const started = performance.now(), events = [], fronts = [], checks = {}, metrics = {};
const player = new PlaybackQueue({ charsPerSecond: 9 });
async function api(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!r.ok) throw new Error(`Bridge HTTP ${r.status}: ${j.error}`); return j;
}
async function until(predicate, timeout, label) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (exitInfo) throw new Error(`Harness exited while ${label}: ${JSON.stringify(exitInfo)}`);
    if (performance.now() > deadline) throw new Error(`Timeout: ${label}`);
    await delay(30);
  }
}
function answers() {
  return events.filter(e => e.type === 'session' && e.data.sessionId === sessionId && e.data.event.type === 'assistant/message')
    .map(e => ({ event: e, text: (e.data.event.data.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('') })).filter(x => x.text);
}
const childStarted = () => events.find(e => e.type === 'child.started');
const childEnded = () => events.find(e => e.type === 'child.ended');
const isFinal = text => answerPhase(text) === 'final';
const isProgress = text => answerPhase(text) === 'progress';
async function front(turnId, text, epoch) {
  try {
    const result = await quickReply({ key, model, text, signal: AbortSignal.timeout(20000) });
    fronts.push({ turnId, ...result }); player.offer({ turnId, role: 'intro', text: result.text, epoch });
    console.log(JSON.stringify({ phase: 'front', turnId, ...result }));
  } catch (error) { player.failIntro(turnId); throw error; }
}
async function prompt(text, delivery) {
  const t = performance.now();
  const result = await api('/prompt', { text, delivery, requestId: randomUUID() });
  metrics.promptAcceptMs ??= []; metrics.promptAcceptMs.push(performance.now() - t); return result;
}
try {
  console.log(JSON.stringify({ phase: 'starting', runDir }));
  await until(() => existsSync(readyFile), 90000, 'profile startup');
  ({ port, sessionId } = JSON.parse(readFileSync(readyFile, 'utf8')));
  poller = setInterval(async () => {
    if (polling) return; polling = true;
    try { const batch = await api(`/events?after=${cursor}`); events.push(...batch.events); cursor = batch.sequence; }
    catch (error) { events.push({ type: 'poll.error', time: Date.now(), data: { message: error.message } }); }
    finally { polling = false; }
  }, 30);
  let lastTick = performance.now();
  ticker = setInterval(() => { const now = performance.now(); player.advance(now - lastTick); lastTick = now; }, 10);
  const epoch1 = player.begin('turn-1'), firstPromptAt = Date.now();
  const shortInput = '帮我在后台校验样例文件，完成后告诉我结果。';
  const frontOne = front('turn-1', shortInput, epoch1);
  await prompt(`你是语音主调度器，最高优先级是响应用户。用户：${shortInput}\n这是受控集成实验：必须用subagent工具创建spawn子任务，主会话不得亲自执行文件或命令。子任务的完整任务是：在 ${fixture.replaceAll('\\', '/')} 下，用pwsh执行 node worker-task.mjs，该脚本等待22秒后读取sample.txt并生成worker-result.json；完成后读取结果，报告SHA256和字节数。不修改其他文件，不继续委派。创建子任务后不要等待，不调用wait_agents，立即回复一整句：我已经安排后台子任务校验样例文件，完成后会把实际结果告诉你。保持主会话响应用户。子任务结果回来后，用【结果】开头报告实际校验结果。`);
  await frontOne;
  await until(() => childStarted() && answers().length, 90000, 'native child start and initial answer');
  const initial = answers().find(x => !isFinal(x.text));
  if (!initial) throw new Error('No initial scheduler reply');
  metrics.schedulerInitialAnswerMs = initial.event.time - firstPromptAt;
  player.offer({ turnId: 'turn-1', role: 'answer', text: initial.text, epoch: epoch1 });
  await until(() => player.playing?.role === 'answer' && player.playing.playedChars >= 5, 15000, 'partial playback');
  const interruptionAt = performance.now(), delivery = player.interrupt();
  metrics.virtualInterruptMs = performance.now() - interruptionAt;
  checks.partialPlayback = delivery.outputs.some(x => x.role === 'answer' && x.playedText && x.unplayedText);
  checks.noCompletedChildBeforeFollowup = !childEnded();
  const epoch2 = player.begin('turn-2'), followupAt = Date.now();
  const frontTwo = front('turn-2', '现在进度怎么样？刚才我打断了你。', epoch2);
  await prompt('我刚才按键打断了你。请先用【进度】开头，简短说出我已听到的回答前缀，并说明哪些还没有播完，告诉我子任务是否仍在执行。不要等子任务结束才回答，不调用wait_agents，不重新执行任务。', delivery);
  await frontTwo;
  await until(() => answers().some(x => x.event.time >= followupAt && isProgress(x.text)), 60000, 'parent response during child work');
  const progress = answers().find(x => x.event.time >= followupAt && isProgress(x.text));
  checks.parentRespondedBeforeChildEnd = !childEnded() || progress.event.time < childEnded().time;
  metrics.followupResponseMs = progress.event.time - followupAt;
  player.offer({ turnId: 'turn-2', role: 'answer', text: progress.text, epoch: epoch2 });
  checks.deliveryLogged = events.some(e => e.type === 'session' && e.data.sessionId === sessionId && e.data.event.type === 'user/message'
    && JSON.stringify(e.data.event.data).includes('virtual-character-clock') && JSON.stringify(e.data.event.data).includes('playedText'));
  const partial = delivery.outputs.find(x => x.role === 'answer' && x.state === 'interrupted');
  checks.schedulerAcknowledgedBoundary = !!partial && progress.text.includes(partial.playedText) && /未|没|剩|后半/.test(progress.text);
  console.log(JSON.stringify({ phase: 'progress', text: progress.text, checks }));
  await until(() => childEnded() && answers().some(x => isFinal(x.text)), 120000, 'completion and final report');
  const final = answers().find(x => isFinal(x.text));
  const artifact = JSON.parse(readFileSync(join(fixture, 'worker-result.json'), 'utf8'));
  checks.realTaskArtifact = artifact.sha256 === createHash('sha256').update(readFileSync(join(fixture, 'sample.txt'))).digest('hex');
  checks.schedulerReportedArtifact = final.text.includes(artifact.sha256);
  player.offer({ turnId: 'turn-2', role: 'answer', text: final.text, epoch: epoch2 }); player.advance(120000);
  const introEnd = player.events.find(e => e.type === 'completed' && e.role === 'intro');
  const mainStart = player.events.find(e => e.type === 'started' && e.role === 'answer');
  checks.naturalHandoff = !!introEnd && !!mainStart && introEnd.at <= mainStart.at;
  metrics.handoffGapMs = mainStart.at - introEnd.at;
  metrics.nativeChildDurationMs = childEnded().time - childStarted().time;
  metrics.totalMs = performance.now() - started;
  metrics.fronts = fronts.map(({ turnId, model, thinking, firstTokenMs, completeMs }) => ({ turnId, model, thinking, firstTokenMs, completeMs }));
  metrics.simulation = { asr: 'predefined final text, zero recognition delay', tts: 'zero synthesis delay, exact character alignment', playbackCharsPerSecond: player.speed, hardware: false };
  checks.noPollErrors = !events.some(e => e.type === 'poll.error');
  const result = { success: Object.values(checks).every(Boolean), checks, metrics, initial: initial.text, progress: progress.text,
    final: final.text, artifact, delivery, playback: player.delivery() };
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  if (!result.success) throw new Error('Acceptance failed: ' + JSON.stringify(checks));
  console.log(JSON.stringify({ phase: 'passed', runDir, checks, metrics }));
} catch (error) {
  writeFileSync(join(runDir, 'failure.json'), JSON.stringify({ message: error.message, checks, metrics }, null, 2));
  console.error(error.message); process.exitCode = 1;
} finally {
  clearInterval(poller); clearInterval(ticker); while (polling) await delay(10);
  writeFileSync(join(runDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(runDir, 'playback.jsonl'), player.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (!exitInfo) { harness.kill('SIGINT'); await Promise.race([exited, delay(8000)]); if (!exitInfo) { harness.kill('SIGKILL'); await exited; } }
  output.end(); writeFileSync(join(runDir, 'process.json'), JSON.stringify({ pid: harness.pid, exitInfo }, null, 2));
}
