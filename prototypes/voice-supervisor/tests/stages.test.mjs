import test from 'node:test';
import assert from 'node:assert/strict';
import { StageQueue } from '../stages.mjs';

const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('new input is accepted during deep work; the native parent never overlaps', async () => {
  const started = barrier(), release = barrier(), calls = [], events = [];
  let active = 0;
  const q = new StageQueue({ observe: event => events.push(event), run: async (phase, job) => {
    assert.equal(++active, 1); calls.push(phase + ':' + job.requestId);
    if (phase === 'thinking' && job.requestId === 'a') { started.resolve(); await release.promise; }
    active--;
  } });
  q.enqueue({ requestId: 'a', text: 'first' }); await started.promise;
  q.enqueue({ requestId: 'b', text: 'second' });
  assert.equal(q.snapshot().queuedInputs, 1); assert.equal(q.snapshot().phase, 'thinking');
  release.resolve(); await q.running;
  assert.deepEqual(calls, ['quick:a', 'thinking:a', 'quick:b', 'thinking:b']);
  assert.equal(events.filter(e => e.kind === 'phase.error').length, 0);
});

test('waiting inputs precede and merge pending continuations without repeating input', async () => {
  const started = barrier(), release = barrier(), calls = [];
  const q = new StageQueue({ observe() {}, run: async (phase, job, batch) => {
    calls.push([phase, job.requestId, batch.length]);
    if (phase === 'quick' && job.requestId === 'a') { started.resolve(); await release.promise; }
  } });
  q.enqueue({ requestId: 'a' }); await started.promise; q.enqueue({ requestId: 'b' });
  release.resolve(); await q.running;
  assert.deepEqual(calls, [['quick', 'a', 1], ['quick', 'b', 1], ['thinking', 'b', 2]]);
  assert.throws(() => q.enqueue({ requestId: 'a' }), /Duplicate/);
});

test('a failed phase exits thinking state and does not strand later input', async () => {
  const events = [], calls = [];
  const q = new StageQueue({ observe: event => events.push(event), run: async (phase, job) => {
    calls.push(phase + ':' + job.requestId); if (job.requestId === 'bad') throw new Error('provider unavailable');
  } });
  q.enqueue({ requestId: 'bad' }); q.enqueue({ requestId: 'good' }); await q.running;
  assert.equal(q.snapshot().phase, 'idle');
  assert.deepEqual(calls, ['quick:bad', 'quick:good', 'thinking:good']);
  assert.equal(events.filter(e => e.kind === 'phase.error').length, 1);
  await q.close(); assert.throws(() => q.enqueue({ requestId: 'closed' }), /closed/);
});

test('failed durable admission cannot execute a rejected request later', () => {
  let calls = 0;
  const q = new StageQueue({ observe() { throw new Error('disk unavailable'); }, run() { calls++; } });
  assert.throws(() => q.enqueue({ requestId: 'rejected' }), /disk unavailable/);
  assert.equal(q.inputs.length, 0); assert.equal(q.seen.size, 0);
  assert.equal(q.running, null); assert.equal(calls, 0);
});
