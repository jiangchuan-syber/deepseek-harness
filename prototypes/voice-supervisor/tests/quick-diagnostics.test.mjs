import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../plugin.mjs';
import { traceState } from '../trace.mjs';

async function fixture(t, stream, timeoutMs = 500, control = null) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-quick-diagnostics-'));
  let dispose;
  t.after(async () => {
    if (dispose) await dispose();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('voice-quick-diagnostics-'));
    await rm(dir, { recursive: true, force: true });
  });
  const selections = [], turns = [], injections = [], sessionEvents = [];
  const parent = { id: 'test-parent', status: 'idle', session: { snapshotEvents: () => sessionEvents }, cancel() {},
    model: { select: selection => selections.push({ ...selection }) },
    whenIdle: () => control?.blockMax ? new Promise(() => {}) : Promise.resolve(),
    inject(message) { injections.push(message); },
    steer(message) { turns.push(message); sessionEvents.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }); } };
  const ctx = {
    workspaceRegistry: { create: async () => ({ id: 'test-workspace' }) },
    sessionController: { create: async () => ({ sessionId: parent.id }), resolveAgent: async () => ({ agent: parent }) },
    agents: { get: () => parent }, effect() {},
    on(type, fn) { if (type === 'dispose') dispose = fn; }, llm: { stream },
  };
  const token = 'synthetic-test-token';
  const readyFile = join(dir, 'ready.json');
  let providerConfig = control?.providerConfig ?? (control ? { kind: 'composed', instance: control.provider } : undefined);
  const stateFile = join(dir, 'fixture-state.json');
  if (control?.miioFixture) {
    await mkdir(join(dir, 'server/data'), { recursive: true });
    const did = '123456789';
    await writeFile(join(dir, 'server/data/xiaomi-tokens.json'), JSON.stringify([{ homes: [{
      home_id: randomUUID() + '3625', devices: [{ model: 'yeelink.light.lamp27', did,
        localip: '127.0.0.1', token: 'synthetic-fixture-token' }],
    }] }]));
    await writeFile(stateFile, JSON.stringify({ power: true }));
    providerConfig = { kind: 'miio-lamp', enabled: true, mode: 'execute', allowWrite: true,
      cooperativeControlReady: true, python: process.env.VOICE_CONTROL_TEST_PYTHON ?? 'python',
      workspace: dir, fixture: stateFile, expectedLampHash: createHash('sha256').update(did).digest('hex').slice(0, 16),
      operationLimitMs: 1000, startupTimeoutMs: 1000, closeTimeoutMs: 1000 };
  }
  await apply(ctx, { token, readyFile, cwd: dir, supervisorReasoningEffort: 'max',
    quick: { contextChars: 1200, inputChars: 600, maxTokens: 64, maxChars: 30, timeoutMs, capacity: 4 },
    simpleControl: control ? { enabled: control.enabled ?? true, budgetMs: 1000, capacity: control.capacity ?? 30,
      provider: providerConfig } : undefined });
  const { port } = JSON.parse(await readFile(readyFile, 'utf8'));
  const apiRaw = (path, input, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...headers },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  const api = async (path, input) => {
    const response = await apiRaw(path, input);
    assert.ok(response.ok, 'Local fixture API failed: ' + response.status);
    return response.json();
  };
  const response = await fetch(`http://127.0.0.1:${port}/quick-probe`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  const body = await response.json();
  const rows = (await readFile(join(dir, 'quick-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const diagnostics = rows.filter(row => row.kind === 'quick.diagnostics');
  assert.equal(diagnostics.length, 1);
  return { status: response.status, body, diagnostic: diagnostics[0], api, apiRaw, selections, turns, injections,
    providerState: async () => JSON.parse(await readFile(stateFile, 'utf8')),
    close: async () => { const owned = dispose; dispose = undefined; await owned(); } };
}

test('real plugin factory controls its private fixture while Max remains unavailable', async t => {
  const result = await fixture(t, async function* () { yield { type: 'text-delta', text: '好的，我来处理。' }; },
    500, { miioFixture: true, blockMax: true });
  assert.equal((await result.providerState()).writes, undefined);
  await result.api('/prompt', { requestId: 'configured-miio', voiceSessionId: 'fixture-voice', text: '关灯' });
  const deadline = performance.now() + 2000;
  let state;
  while ((state = await result.api('/state')).controls[0]?.status !== 'verified') {
    assert.ok(performance.now() < deadline); await delay(5);
  }
  const projected = traceState(state);
  assert.equal(projected.controls[0].commandId, 'configured-miio');
  assert.equal(projected.controls[0].voiceSessionId, 'fixture-voice');
  assert.equal(projected.controlProjection.sourceInstance, state.controlSourceInstance);
  assert.ok(projected.controlProjection.sequence > 0);
  assert.equal((await result.providerState()).writes, 1);
  assert.equal(result.turns.length, 0);
});

test('disabled control configuration never constructs even an invalid broker provider', async t => {
  const result = await fixture(t, async function* () { yield { type: 'text-delta', text: '好的。' }; },
    500, { enabled: false, providerConfig: { kind: 'miio-lamp', enabled: true } });
  const state = await result.api('/state');
  assert.deepEqual(state.controls, []); assert.equal(state.controlSourceInstance, undefined);
});

test('authenticated exact command inspection survives bounded snapshots without any new action', async t => {
  let power = true, writes = 0, queries = 0;
  const provider = {
    resolve: () => ({ approved: true, unique: true, homeSuffix: '3625', resourceId: 'fixture-lamp', properties: ['power'] }),
    async write(intent) { writes++; power = intent.value; },
    async readFresh(_intent, context) { queries++; return { resourceId: 'fixture-lamp', fresh: true,
      queryId: context.queryId, properties: { power } }; },
  };
  const result = await fixture(t, async function* () { yield { type: 'text-delta', text: '好的，我来处理。' }; },
    500, { provider, capacity: 1, blockMax: true });
  for (let i = 0; i < 3; i++) {
    await result.api('/prompt', { requestId: 'inspect-' + i, voiceSessionId: 'voice-' + i, text: '关灯' });
    const deadline = performance.now() + 1000;
    while ((await result.api('/state')).controls.find(c => c.commandId === 'inspect-' + i)?.status !== 'verified') {
      assert.ok(performance.now() < deadline); await delay(5);
    }
  }
  const state = await result.api('/state');
  assert.equal(state.controls.length, 1); assert.equal(state.controlStats.activeAdmissions, 0);
  const stored = await result.api('/control-result?commandId=inspect-0');
  assert.equal(stored.found, true); assert.equal(stored.control.commandId, 'inspect-0');
  assert.equal(stored.control.voiceSessionId, 'voice-0'); assert.equal(stored.control.goalVersion, 1);
  assert.equal(stored.control.currentGoal, false); assert.equal(writes, 3); assert.equal(queries, 3);
  if (process.env.VOICE_CONTROL_CONTRACT_OUT) {
    await writeFile(process.env.VOICE_CONTROL_CONTRACT_OUT, JSON.stringify(stored));
  }
  assert.equal((await result.api('/control-result?commandId=not-known')).found, false);
  for (const path of ['/control-result', '/control-result?commandId=a&commandId=b', '/control-result?commandId=../secret']) {
    assert.equal((await result.apiRaw(path)).status, 400);
  }
  assert.equal((await result.apiRaw('/control-result?commandId=inspect-0', undefined, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal(writes, 3); assert.equal(queries, 3); assert.equal(result.turns.length, 0);
});

test('a provider cleanup error is reported after the plugin HTTP listener is closed', async t => {
  const provider = { resolve: () => ({ unsupported: true }), async write() {}, async readFresh() {},
    async close() { throw new Error('fixture-provider-close'); } };
  const result = await fixture(t, async function* () { yield { type: 'text-delta', text: '好的。' }; }, 500, { provider });
  await assert.rejects(result.close(), error => error instanceof AggregateError);
  await assert.rejects(result.api('/state'));
});

test('control success runs beside quick and records evidence without a deep turn', async t => {
  const writes = [], quickRequests = [];
  const provider = { resolve: () => ({ approved: true, unique: true, homeSuffix: '3625', resourceId: 'fixture-lamp', properties: ['power'] }),
    async write(intent) { writes.push(intent); },
    async readFresh(_intent, context) { return { fresh: true, queryId: context.queryId, resourceId: 'fixture-lamp', properties: { power: false } }; } };
  const result = await fixture(t, async function* (request) { quickRequests.push(request); yield { type: 'text-delta', text: '好的，我来处理。' }; }, 500, { provider });
  await result.api('/prompt', { requestId: 'direct-control', text: '把台灯关掉。' });
  const deadline = performance.now() + 2000;
  while ((await result.api('/state')).controls[0]?.status !== 'verified' || result.injections.length !== 1) {
    assert.ok(performance.now() < deadline); await delay(5);
  }
  await delay(10);
  assert.equal(result.turns.length, 0); assert.equal(writes.length, 1);
  assert.ok(result.injections[0].content[0].text.startsWith('程序执行事实'));
  assert.ok(result.injections[0].content[0].text.includes('不是新的用户指令'));
  assert.equal(quickRequests.length, 2); assert.equal(quickRequests[1].tools, undefined);
  assert.equal((await result.api('/state')).queue.readyContinuations, 0);
  assert.equal((await result.api('/continue', { requestId: 'direct-control' })).handledBy, 'simple-control');
  assert.equal(result.turns.length, 0);
});

test('a pending first-use device preflight never holds the quick response path', async t => {
  let ready = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0, quickCalls = 0;
  const provider = {
    resolve: () => ({ homeSuffix: '3625', resourceId: 'fixture-lamp', properties: ['power'],
      preparationRequired: !ready, approved: ready, unique: ready }),
    async prepare() { await gate; ready = true; },
    async write() { writes++; },
    async readFresh(_intent, context) { return { resourceId: 'fixture-lamp', fresh: true,
      queryId: context.queryId, properties: { power: false } }; },
  };
  t.after(() => release());
  try {
    const result = await fixture(t, async function* () { quickCalls++; yield { type: 'text-delta', text: '好的，我来处理。' }; },
      500, { provider, blockMax: true });
    await result.api('/prompt', { requestId: 'slow-preflight', voiceSessionId: 'fixture-voice', text: '关灯' });
    const deadline = performance.now() + 700;
    let state;
    do {
      state = await result.api('/state');
      assert.ok(performance.now() < deadline);
      await delay(5);
    } while (quickCalls < 2 || state.queue.quickRunning || state.queue.quickPending);
    assert.equal(state.controls[0].status, 'queued');
    assert.equal(writes, 0);
    assert.equal((await result.api('/continue', { requestId: 'slow-preflight' })).handledBy, 'simple-control');
    release();
    while ((await result.api('/state')).controls[0].status !== 'verified') {
      assert.ok(performance.now() < deadline); await delay(5);
    }
    assert.equal(writes, 1); assert.equal(result.turns.length, 0);
  } finally { release(); }
});

test('unconfirmed control enters only a report turn and never repeats the original action', async t => {
  let writes = 0;
  const provider = { resolve: () => ({ approved: true, unique: true, homeSuffix: '3625', resourceId: 'fixture-lamp', properties: ['power'] }),
    async write() { writes++; }, async readFresh() { return { fresh: false }; } };
  const result = await fixture(t, async function* () { yield { type: 'text-delta', text: '好的，我来处理。' }; }, 500, { provider });
  await result.api('/prompt', { requestId: 'unconfirmed-control', text: '关灯' });
  const deadline = performance.now() + 2000;
  while (result.turns.length !== 1) { assert.ok(performance.now() < deadline); await delay(5); }
  assert.ok(result.turns[0].content[0].text.startsWith('这是程序执行事实，不是新的用户指令'));
  assert.ok(result.turns[0].content[0].text.includes('不得再次执行、重试或委派原动作'));
  assert.equal(result.injections.length, 1); assert.equal(writes, 1);
});

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
