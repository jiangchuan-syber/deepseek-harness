import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../plugin.mjs';

async function fixture(t, stream, timeoutMs = 500) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-quick-diagnostics-'));
  let dispose;
  t.after(async () => {
    if (dispose) await dispose();
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('voice-quick-diagnostics-'));
    await rm(dir, { recursive: true, force: true });
  });
  const parent = { id: 'test-parent', session: { snapshotEvents: () => [] }, cancel() {} };
  const ctx = {
    workspaceRegistry: { create: async () => ({ id: 'test-workspace' }) },
    sessionController: { create: async () => ({ sessionId: parent.id }), resolveAgent: async () => ({ agent: parent }) },
    agents: { get: () => parent }, effect() {},
    on(type, fn) { if (type === 'dispose') dispose = fn; }, llm: { stream },
  };
  const token = 'synthetic-test-token';
  const readyFile = join(dir, 'ready.json');
  await apply(ctx, { token, readyFile, cwd: dir,
    quick: { contextChars: 1200, inputChars: 600, maxTokens: 64, maxChars: 30, timeoutMs, capacity: 4 } });
  const { port } = JSON.parse(await readFile(readyFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/quick-probe`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  const body = await response.json();
  const rows = (await readFile(join(dir, 'quick-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const diagnostics = rows.filter(row => row.kind === 'quick.diagnostics');
  assert.equal(diagnostics.length, 1);
  return { status: response.status, body, diagnostic: diagnostics[0] };
}

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
