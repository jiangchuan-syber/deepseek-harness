import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeHealth } from '../health.mjs';
test('startup and short dependency failure affect readiness, not liveness', () => {
  assert.deepEqual(runtimeHealth({ exited: false, stopping: false, lastPollAt: 0 }), { live: true, ready: false, pollAgeMs: null });
  assert.deepEqual(runtimeHealth({ exited: false, stopping: false, lastPollAt: 1000, now: 16000 }), { live: true, ready: false, pollAgeMs: 15000 });
});
test('dead child, shutdown and a prolonged native hang are unhealthy', () => {
  for (const options of [{ exited: true }, { stopping: true }, { now: 62000 }]) {
    const h = runtimeHealth({ exited: false, stopping: false, lastPollAt: 1000, now: 2000, ...options });
    assert.equal(h.live, false); assert.equal(h.ready, false);
  }
});
