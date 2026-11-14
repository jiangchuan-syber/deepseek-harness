import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../plugin.mjs';

async function fixture(t, stream, timeoutMs = 500, { probe = true, parentId = 'test-parent' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-quick-diagnostics-'));
  let dispose;
  t.after(async () => {
    if (dispose) await dispose();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('voice-quick-diagnostics-'));
    await rm(dir, { recursive: true, force: true });
  });
  const selections = [], turns = [], sessionEvents = [], parentCancellations = [], childInterruptions = [];
  const parent = { id: parentId, status: 'idle', session: { snapshotEvents: () => sessionEvents }, cancel: reason => parentCancellations.push(reason),
    model: { select: selection => selections.push({ ...selection }) }, whenIdle: async () => {},
    steer(message) { turns.push(message); sessionEvents.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }); } };
  const ctx = {
    workspaceRegistry: { create: async () => ({ id: 'test-workspace' }) },
    sessionController: { create: async () => ({ sessionId: parent.id }), resolveAgent: async () => ({ agent: parent }) },
    agents: { get: () => parent }, subagents: { interrupt: (...args) => childInterruptions.push(args) }, effect() {},
    on(type, fn) { if (type === 'dispose') dispose = fn; }, llm: { stream },
  };
  const token = 'synthetic-test-token';
  const readyFile = join(dir, 'ready.json');
  await apply(ctx, { token, readyFile, cwd: dir, supervisorReasoningEffort: 'max',
    quick: { contextChars: 1200, inputChars: 600, maxTokens: 64, maxChars: 30, timeoutMs, capacity: 4,
      cancelGraceMs: 10, maxOutstanding: 2 } });
  const { port } = JSON.parse(await readFile(readyFile, 'utf8'));
  const request = (path, input) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  const api = async (path, input) => {
    const response = await request(path, input);
    assert.ok(response.ok, 'Local fixture API failed: ' + response.status);
    return response.json();
  };
  const readRows = async () => (await readFile(join(dir, 'quick-requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!probe) return { api, request, selections, turns, readRows, parentCancellations, childInterruptions };
  const response = await fetch(`http://127.0.0.1:${port}/quick-probe`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  const body = await response.json();
  const rows = (await readFile(join(dir, 'quick-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const diagnostics = rows.filter(row => row.kind === 'quick.diagnostics');
  assert.equal(diagnostics.length, 1);
  return { status: response.status, body, diagnostic: diagnostics[0], api, selections, turns };
}

test('native parent keeps max across startup and continuation while quick requests stay off', async t => {
  const quickEfforts = [];
  const result = await fixture(t, async function* (request) {
    quickEfforts.push(request.reasoningEffort);
    yield { type: 'text-delta', text: '收到。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  assert.deepEqual(result.selections.map(selection => selection.reasoningEffort), ['max']);
  await result.api('/prompt', { requestId: 'max-continuation-test', text: '检查本次设置。' });
  const deadline = performance.now() + 2000;
  while ((await result.api('/state')).queue.readyContinuations !== 1) {
    assert.ok(performance.now() < deadline, 'Quick handoff exceeded fixture deadline');
    await delay(5);
  }
  await result.api('/continue', { requestId: 'max-continuation-test' });
  while ((await result.api('/state')).queue.phase !== 'idle') {
    assert.ok(performance.now() < deadline, 'Native continuation exceeded fixture deadline');
    await delay(5);
  }
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.selections.map(selection => selection.reasoningEffort), ['max', 'max', 'max']);
  assert.deepEqual(quickEfforts, ['off', 'off']);
});

test('natural quick text remains in recent input and native deep continuation', async t => {
  const requests = [];
  const result = await fixture(t, async function* (request) {
    requests.push(request);
    assert.equal(request.reasoningEffort, 'off');
    assert.equal(request.tools, undefined);
    yield { type: 'text-delta', text: '好的，我查一下。' };
  });
  for (const id of ['natural-first', 'natural-second']) {
    await result.api('/prompt', { requestId: id, text: '请检查测试目标。' });
    const deadline = performance.now() + 2000;
    while ((await result.api('/state')).queue.readyContinuations !== 1) {
      assert.ok(performance.now() < deadline, 'Quick handoff exceeded fixture deadline');
      await delay(5);
    }
    await result.api('/continue', { requestId: id });
    while ((await result.api('/state')).queue.phase !== 'idle') {
      assert.ok(performance.now() < deadline, 'Native continuation exceeded fixture deadline');
      await delay(5);
    }
  }
  assert.equal(requests.length, 3); // Probe, first input, then the input with recent history.
  assert.ok(requests[2].messages[0].content[0].text.includes('助手：好的，我查一下。'));
  assert.equal(result.turns.length, 2);
  for (const turn of result.turns) {
    const instruction = turn.content[0].text;
    const inputs = JSON.parse(instruction.split('\n').at(-1));
    assert.deepEqual(inputs, [{ input: '请检查测试目标。', quickReply: '好的，我查一下。' }]);
    assert.ok(instruction.includes('推理、复杂或多步骤任务'));
    assert.ok(instruction.includes('缺证据要说明未验证'));
    assert.ok(instruction.includes('不原样播简报'));
    assert.ok(instruction.includes('简报不是新授权'));
    assert.ok(instruction.includes('用户打断声音不等于暂停后台Agent'));
  }
});

test('empty quick stops fail visibly and continue without a fabricated acknowledgement', async t => {
  const result = await fixture(t, async function* () {
    yield { type: 'text-delta', text: '<｜DSML' };
  });
  assert.equal(result.status, 400);
  assert.equal(result.diagnostic.spokenTextChars, 0);
  await result.api('/prompt', { requestId: 'empty-quick', text: '检查测试状态。' });
  const deadline = performance.now() + 2000;
  while ((await result.api('/state')).queue.readyContinuations !== 1) {
    assert.ok(performance.now() < deadline, 'Empty quick did not settle');
    await delay(5);
  }
  await result.api('/continue', { requestId: 'empty-quick' });
  while ((await result.api('/state')).queue.phase !== 'idle') {
    assert.ok(performance.now() < deadline, 'Continuation did not settle');
    await delay(5);
  }
  const inputs = JSON.parse(result.turns[0].content[0].text.split('\n').at(-1));
  assert.deepEqual(inputs, [{ input: '检查测试状态。', quickReply: '' }]);
  assert.ok(result.turns[0].content[0].text.includes('quickReply为空表示没有可用接话'));
  assert.ok(!result.turns[0].content[0].text.includes('快速接话已经完成了开口'));
});

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}

test('quick diagnostics distinguish whitespace TTFT, Unicode text and a terminal finish', async t => {
  const result = await fixture(t, async function* (request) {
    assert.equal(request.maxTokens, 64); assert.equal(request.reasoningEffort, 'off');
    yield { type: 'text-delta', text: ' \t' };
    await delay(12);
    yield { type: 'text-delta', text: '好' };
    yield { type: 'text-delta', text: '😀' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const d = result.diagnostic;
  assert.equal(result.status, 200); assert.equal(d.outcome, 'completed');
  assert.equal(d.receivedTextChars, 4); assert.equal(d.nonWhitespaceCharacterCount, 2);
  assert.equal(d.spokenTextChars, 2); assert.equal(d.textDeltaCount, 3);
  assert.ok(d.firstNonWhitespaceTextMs > d.firstTextMs);
  assert.equal(result.body.firstTextMs, d.firstTextMs); // Existing TTFT remains unchanged.
  assert.equal(d.finishReceived, true); assert.equal(d.finishReason, 'stop');
  assert.equal(d.streamExit, 'exhausted'); assert.equal(d.timeoutFiredAtMs, null);
  assert.equal(d.streamCloseMs, null); assert.ok(d.lastTextDeltaAgeMs >= 0);
});

test('quick diagnostics time iterator cleanup separately from a completed sentence', async t => {
  const result = await fixture(t, () => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: { type: 'text-delta', text: '收到。后文' } }; },
    async return() { await delay(20); return { done: true }; },
  }));
  const d = result.diagnostic;
  assert.equal(result.status, 200); assert.equal(d.receivedTextChars, 5);
  assert.equal(d.spokenTextChars, 3); assert.equal(d.streamExit, 'short-reply');
  assert.equal(d.finishReceived, false); assert.equal(d.finishReason, null);
  assert.ok(d.streamCloseMs >= 15); assert.ok(d.streamCloseStartedMs >= 0);
  assert.equal(d.streamCloseError, null); assert.equal(d.timeoutFiredAtMs, null);
});

test('a sentence can be complete while iterator cleanup waits until the timeout', async t => {
  const privateText = 'PRIVATE_RESPONSE_BODY_AND_CREDENTIAL';
  const result = await fixture(t, request => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: { type: 'text-delta', text: '收到。' } }; },
    async return() {
      await waitForAbort(request.signal);
      const cause = Object.assign(new Error(privateText), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
      throw Object.assign(new Error(privateText, { cause }), { name: 'AbortError' });
    },
  }), 50);
  const d = result.diagnostic;
  assert.equal(result.status, 400); assert.equal(d.outcome, 'failed');
  assert.equal(d.spokenTextChars, 3); assert.equal(d.textDeltaCount, 1);
  assert.equal(d.streamExit, 'short-reply'); assert.equal(d.finishReceived, false);
  assert.ok(d.timeoutFiredAtMs >= 40); assert.ok(d.streamCloseMs >= 35);
  assert.equal(d.error.type, 'AbortError'); assert.equal(d.error.causeType, 'SocketError');
  assert.equal(d.error.causeCode, 'UND_ERR_SOCKET');
  assert.equal(d.streamCloseError.type, 'AbortError'); assert.equal(d.partialTextFallback, false);
  assert.ok(!JSON.stringify(d).includes(privateText));
  assert.ok(!JSON.stringify(d).includes('synthetic-test-token'));
});

test('partial-text AbortError fallback is still used and remains observable', async t => {
  const result = await fixture(t, async function* (request) {
    yield { type: 'text-delta', text: '收' };
    await waitForAbort(request.signal);
    throw Object.assign(new Error('private error message'), { name: 'AbortError' });
  }, 50);
  const d = result.diagnostic;
  assert.equal(result.status, 200); assert.equal(d.outcome, 'completed');
  assert.equal(d.receivedTextChars, 1); assert.equal(d.spokenTextChars, 2);
  assert.equal(d.partialTextFallback, true); assert.equal(d.error.type, 'AbortError');
  assert.equal(d.streamCloseMs, null); assert.ok(d.timeoutFiredAtMs >= 40);
});

test('normalized finish failure keeps only machine reason, code and HTTP status', async t => {
  const privateText = 'PRIVATE_PROVIDER_RESPONSE_BODY';
  const result = await fixture(t, async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'NETWORK_ERROR', status: 502, message: privateText, requestId: privateText,
    } } };
  });
  const d = result.diagnostic;
  assert.equal(result.status, 400); assert.equal(d.outcome, 'failed');
  assert.equal(d.finishReceived, true); assert.equal(d.finishReason, 'error');
  assert.deepEqual(d.finishFailure, { code: 'NETWORK_ERROR', status: 502 });
  assert.equal(d.receivedTextChars, 0); assert.equal(d.firstNonWhitespaceTextMs, null);
  assert.equal(d.lastTextDeltaAgeMs, null); assert.ok(!JSON.stringify(d).includes(privateText));
});

test('no-text timeout is distinct from partial text and closing a short reply', async t => {
  const result = await fixture(t, request => ({
    [Symbol.asyncIterator]() { return this; },
    async next() {
      await waitForAbort(request.signal);
      throw Object.assign(new Error('private timeout message'), { name: 'AbortError' });
    },
  }), 50);
  const d = result.diagnostic;
  assert.equal(result.status, 400); assert.equal(d.outcome, 'failed');
  assert.equal(d.receivedTextChars, 0); assert.equal(d.textDeltaCount, 0);
  assert.equal(d.firstTextMs, null); assert.equal(d.firstNonWhitespaceTextMs, null);
  assert.equal(d.lastTextDeltaAgeMs, null); assert.equal(d.partialTextFallback, false);
  assert.equal(d.streamCloseMs, null); assert.ok(d.timeoutFiredAtMs >= 40);
});

const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check, message) {
  const deadline = performance.now() + 2000;
  while (!(await check())) { assert.ok(performance.now() < deadline, message); await delay(5); }
}

test('new recording IDs share only their native parent cancellation scope and emit no stale quick text or end', async t => {
  const oldStarted = barrier(); let oldSignal;
  const result = await fixture(t, async function* (request) {
    const input = request.messages[0].content[0].text;
    if (input.endsWith('first goal')) {
      oldSignal = request.signal;
      yield { type: 'text-delta', text: '先' }; oldStarted.resolve();
      await waitForAbort(request.signal);
      yield { type: 'text-delta', text: '旧内容不能输出。' }; // A provider can yield after abort.
    } else yield { type: 'text-delta', text: '好的，马上处理。' };
  }, 500, { probe: false });
  await result.api('/prompt', { requestId: 'old-turn', voiceSessionId: 'recording-one',
    quickParentSessionId: 'caller-cannot-select-parent-one', text: 'first goal' });
  await oldStarted.promise;
  await result.api('/prompt', { requestId: 'new-turn', voiceSessionId: 'recording-two',
    quickParentSessionId: 'caller-cannot-select-parent-two', text: 'second goal' });
  await until(async () => (await result.api('/state')).queue.readyContinuations === 2, 'Both original goals did not settle');
  assert.equal(oldSignal.aborted, true);
  const { events } = await result.api('/events?after=0');
  const accepted = events.find(event => event.type === 'prompt.accepted' && event.data.requestId === 'new-turn');
  assert.ok(!events.some(event => event.sequence > accepted.sequence && event.data?.owner?.requestId === 'old-turn'
    && ['speech.delta', 'quick.completed'].includes(event.type)));
  assert.ok(events.some(event => event.type === 'quick.superseded' && event.data.owner.requestId === 'old-turn'));
  const rows = await result.readRows();
  assert.ok(!rows.some(row => row.kind === 'quick.reply' && row.requestId === 'old-turn'));
  const diagnostic = rows.find(row => row.kind === 'quick.diagnostics' && row.requestId === 'old-turn');
  assert.equal(diagnostic.outcome, 'superseded'); assert.equal(diagnostic.partialTextFallback, false);
  assert.equal(diagnostic.spokenTextChars, 1); // No fabricated punctuation for the superseded half-clause.
  assert.ok(rows.filter(row => row.kind === 'quick.admitted').every(row => row.job.quickParentSessionId === 'test-parent'));
  await result.api('/continue', { requestId: 'old-turn' });
  await result.api('/continue', { requestId: 'new-turn' });
  await until(async () => (await result.api('/state')).queue.phase === 'idle', 'Deep continuation did not settle');
  const inputs = result.turns.flatMap(turn => JSON.parse(turn.content[0].text.split('\n').at(-1)));
  assert.ok(inputs.some(input => input.input === 'first goal' && input.quickReply === ''));
  assert.ok(inputs.some(input => input.input === 'second goal' && input.quickReply === '好的，马上处理。'));
  assert.deepEqual(result.parentCancellations, []); assert.deepEqual(result.childInterruptions, []);
});

test('a completed old sentence whose return ignores abort cannot delay or publish over the new quick', async t => {
  const cleanupStarted = barrier(), releaseCleanup = barrier(); let oldSignal;
  const result = await fixture(t, request => {
    if (request.messages[0].content[0].text.endsWith('old cleanup')) {
      oldSignal = request.signal;
      return { [Symbol.asyncIterator]() { return this; },
        async next() { return { done: false, value: { type: 'text-delta', text: '旧句。' } }; },
        async return() { cleanupStarted.resolve(); await releaseCleanup.promise; return { done: true }; } };
    }
    return (async function* () { yield { type: 'text-delta', text: '现在处理。' }; })();
  }, 500, { probe: false });
  try {
    await result.api('/prompt', { requestId: 'old-cleanup', text: 'old cleanup' }); await cleanupStarted.promise;
    await result.api('/prompt', { requestId: 'latest-cleanup', text: 'latest cleanup' });
    await until(async () => (await result.api('/state')).queue.readyContinuations === 2, 'New quick remained behind old iterator.return');
    assert.equal(oldSignal.aborted, true);
    let rows = await result.readRows();
    assert.ok(rows.some(row => row.kind === 'quick.reply' && row.requestId === 'latest-cleanup'));
    assert.ok(!rows.some(row => row.kind === 'quick.reply' && row.requestId === 'old-cleanup'));
    releaseCleanup.resolve();
    await until(async () => (await result.api('/state')).queue.quickOutstanding === 0, 'Owned iterator did not quiesce');
    rows = await result.readRows();
    assert.ok(!rows.some(row => row.kind === 'quick.reply' && row.requestId === 'old-cleanup'));
    const { events } = await result.api('/events?after=0');
    assert.ok(!events.some(event => event.type === 'quick.completed' && event.data.owner.requestId === 'old-cleanup'));
    assert.ok(events.some(event => event.type === 'quick.cleanup_pending'));
  } finally { releaseCleanup.resolve(); }
});

test('separate native parent instances keep their provider signals independent', async t => {
  const firstStarted = barrier(), secondStarted = barrier(), releaseSecond = barrier(); let firstSignal, secondSignal;
  const first = await fixture(t, async function* (request) {
    if (request.messages[0].content[0].text.endsWith('hold first')) {
      firstSignal = request.signal; firstStarted.resolve(); await waitForAbort(request.signal);
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    }
    yield { type: 'text-delta', text: '第一会话。' };
  }, 500, { probe: false, parentId: 'parent-one' });
  const second = await fixture(t, async function* (request) {
    secondSignal = request.signal; secondStarted.resolve(); await releaseSecond.promise;
    yield { type: 'text-delta', text: '第二会话。' };
  }, 500, { probe: false, parentId: 'parent-two' });
  try {
    await first.api('/prompt', { requestId: 'one', text: 'hold first' }); await firstStarted.promise;
    await second.api('/prompt', { requestId: 'two', text: 'hold second' }); await secondStarted.promise;
    await first.api('/prompt', { requestId: 'one-new', text: 'new first' });
    await until(async () => (await first.api('/state')).queue.readyContinuations === 2, 'First scope did not settle');
    assert.equal(firstSignal.aborted, true); assert.equal(secondSignal.aborted, false);
  } finally { releaseSecond.resolve(); }
});

test('invalid cleanup budgets fail before creating any native parent', async () => {
  let created = 0;
  const ctx = { workspaceRegistry: { create() { created++; throw new Error('unexpected workspace creation'); } } };
  const quick = { contextChars: 1200, inputChars: 600, maxTokens: 64, maxChars: 30,
    timeoutMs: 100, capacity: 4, cancelGraceMs: 10, maxOutstanding: 2 };
  for (const overrides of [{ cancelGraceMs: 0 }, { cancelGraceMs: 101 }, { maxOutstanding: 3 }, { maxOutstanding: 0 }]) {
    await assert.rejects(apply(ctx, { token: 'synthetic', readyFile: 'unused', cwd: 'unused',
      supervisorReasoningEffort: 'max', quick: { ...quick, ...overrides } }), /quick[. ]/);
  }
  assert.equal(created, 0);
});

test('HTTP diagnostics reject overlap and their unresolved provider shares the real quick budget', async t => {
  const started = barrier(), release = barrier(); let probeSignal, calls = 0;
  const result = await fixture(t, async function* (request) {
    calls++;
    if (request.messages[0].content[0].text.endsWith('你好，现在能听到吗？')) {
      probeSignal = request.signal; started.resolve(); await release.promise;
      yield { type: 'text-delta', text: 'obsolete probe text' };
    } else yield { type: 'text-delta', text: '处理本轮。' };
  }, 500, { probe: false });
  const pendingProbe = result.request('/quick-probe', {});
  try {
    await started.promise;
    assert.equal((await result.request('/quick-probe', {})).status, 409);
    await result.api('/prompt', { requestId: 'real-with-probe', text: 'real input' });
    await until(async () => (await result.api('/state')).queue.readyContinuations === 1, 'Diagnostic blocked real quick');
    assert.equal(probeSignal.aborted, true); assert.equal(calls, 2);
    const state = await result.api('/state');
    assert.equal(state.queue.quickProbeRunning, true); assert.equal(state.queue.quickOutstanding, 1);
    assert.equal((await result.request('/quick-probe', {})).status, 409);
    release.resolve(); assert.equal((await pendingProbe).status, 400);
    await until(async () => (await result.api('/state')).queue.quickOutstanding === 0, 'Diagnostic cleanup did not settle');
  } finally { release.resolve(); await pendingProbe; }
});
