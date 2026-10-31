/** Real-provider acceptance against a fresh isolated interactive runner; no device audio is claimed. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdDecompressSync } from 'node:zlib';
import { scanZstdFrames } from '../../packages/session/session-persistence-jsonl/src/zstd.ts';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
async function api(path, body) {
  const response = await fetch(config.url + path, { headers: { 'x-lab-token': config.token, 'content-type': 'application/json' },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, 'Local test API failed: ' + response.status); return response.json();
}
const initial = await api('/state');
assert.equal(initial.messages.length, 0, 'Use a fresh isolated runner, not an existing user conversation');
assert.equal(initial.nativeState.conversationStarted, false, 'Do not run acceptance against a resumed conversation');
assert.equal(readFileSync(join(initial.workspace, 'sample.txt'), 'utf8'), 'voice-supervisor-reusable-fixture\n');
assert.ok(!existsSync(join(initial.workspace, 'worker-result.json')));
await api('/send', { text: '请创建一个原生 subagent 子任务，在当前目录执行 node worker-task.mjs，等待生成 worker-result.json。只安排一次任务，结束后向我汇报校验 sha256 和字节数。', voiceSessionId: 'staged-check-a' });
const deadline = Date.now() + 300000;
let state, second = false, sawThinking = false, sawQueued = false, settled = false;
while (Date.now() < deadline) {
  state = await api('/state'); const native = state.nativeState;
  sawThinking ||= native.phase === 'thinking'; sawQueued ||= (native.queue?.queuedInputs ?? 0) > 0;
  if (!second && native.phase === 'thinking') {
    await api('/send', { text: '后台校验继续，不要重新安排第二个任务。请简短确认这个补充。', voiceSessionId: 'staged-check-b' }); second = true;
  }
  if (native.status === 'idle' && native.queue?.phase === 'idle' && !native.queue?.queuedInputs
    && !native.queue?.pendingContinuations && native.children.length && native.children.every(c => c.ended)) { settled = true; break; }
  await delay(250);
}
assert.ok(settled, 'Native staged flow exceeded deadline');
const trace = (await api('/trace')).events;
const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? walk(join(path, entry.name)) : entry.name.endsWith('.zstd') ? [join(path, entry.name)] : []);
const sessions = walk(join(config.runDir, 'home/sessions')).map(path => {
  const bytes = readFileSync(path); return scanZstdFrames(bytes).frames.flatMap(({ start, end }) =>
    zstdDecompressSync(bytes.subarray(start, end)).toString().trim().split('\n').map(line => JSON.parse(line)));
});
const parent = sessions.find(events => !events[0].parentSession);
const headers = parent.filter(e => e.type === 'request/header');
const quick = headers.filter(e => e.data.header.config.reasoningEffort === 'off');
const deep = headers.filter(e => e.data.header.config.reasoningEffort === 'high');
assert.equal(quick.length, 2); assert.ok(quick.every(e => !e.data.header.tools?.length)); assert.ok(deep.length > 0);
assert.equal(parent.filter(e => e.type === 'user/message' && e.data.source?.rpcId).length, 2);
const continuations = parent.filter(e => e.type === 'user/message' && e.data.source?.kind === 'voice-continuation');
assert.ok(continuations.length > 0 && continuations.every(e => e.data.content.some(c => c.text?.includes('程序内部续接'))));
assert.ok(parent.some(e => e.type === 'assistant/message' && e.data.stream?.some(r => r.type === 'reasoning-chunks')));
assert.ok(sawThinking && sawQueued);
assert.equal(state.nativeState.children.length, 1); assert.equal(state.nativeState.children[0].stopReason, 'completed');
assert.equal(state.messages.filter(m => m.role === '错误').length, 0);
const expected = createHash('sha256').update(readFileSync(join(state.workspace, 'sample.txt'))).digest('hex');
assert.deepEqual(JSON.parse(readFileSync(join(state.workspace, 'worker-result.json'), 'utf8')), { sha256: expected, bytes: 34 });
const relay = trace.find(e => e.kind === 'child.relay'); assert.ok(relay);
assert.ok(trace.some(e => e.kind === 'scheduler.reply' && e.at >= relay.at && e.text.includes(expected)));
const evidence = { date: new Date().toISOString(), provider: 'deepseek-official', model: 'deepseek-flash',
  observedThinking: sawThinking, acceptedInputDuringThinking: sawQueued, nativeUserInputs: 2,
  quickRequestsWithoutTools: quick.length, deepRequestHeaders: deep.length, internalContinuations: continuations.length,
  childCount: 1, childCompleted: true, resultEnteredParent: true, parentReportedVerifiedHash: true,
  artifactIndependentlyVerified: true, audio: 'virtual; no physical playback claim',
  quickTimings: trace.filter(e => e.kind === 'front.reply').map(e => e.details) };
writeFileSync(join(config.runDir, 'staged-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
