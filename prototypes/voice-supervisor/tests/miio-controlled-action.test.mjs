import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledAction } from '../miio-controlled-action.mjs';

function fixture(options = {}) {
  let power = true, reads = 0, writes = 0, closed = false;
  const facts = [];
  const resourceId = 'fixture-lamp';
  const provider = {
    child: null,
    resolve: () => ({ approved: true, unique: true, homeSuffix: '3625', resourceId, properties: ['power'] }),
    readFresh: async (_intent, context) => {
      reads++;
      options.onRead?.(reads);
      return { resourceId, queryId: context.queryId, fresh: true,
        networkIdentityVerified: options.identity !== false, properties: { power } };
    },
    write: async (intent, context) => {
      if (!context.isCurrent()) throw Object.assign(new Error('denied'), { outcome: 'not_started' });
      writes++;
      power = intent.value;
      if (options.unknown) throw new Error('unknown');
    },
    close: async () => { closed = true; },
  };
  return { provider, facts, store: { load: () => facts, append: fact => facts.push(fact) },
    args: { commandId: 'new-command', expectedCurrentPower: true, targetPower: false,
      allowWriteTest: true, sessionValid: () => true },
    stats: () => ({ reads, writes, closed, power }) };
}

test('default disabled does not contact provider', async () => {
  const f = fixture();
  const result = await controlledAction({ ...f.args, provider: f.provider, store: f.store, allowWriteTest: false });
  assert.equal(result.status, 'NOT_RUN'); assert.equal(f.stats().reads, 0); assert.equal(f.stats().writes, 0);
});

test('one persisted command and separate fresh read, no automatic restoration', async () => {
  const f = fixture();
  const result = await controlledAction({ ...f.args, provider: f.provider, store: f.store });
  assert.equal(result.status, 'PASS'); assert.equal(result.goalAcceptance, 'NOT_RUN');
  assert.equal(result.automaticRestore, false); assert.equal(f.stats().writes, 1);
  assert.equal(f.stats().reads, 2); assert.equal(f.stats().power, false); assert.equal(f.stats().closed, true);
  assert.equal(f.facts.at(-1).value.status, 'verified');
});

test('unexpected current state or missing network identity never writes', async () => {
  for (const [args, options] of [[{ expectedCurrentPower: false, targetPower: true }, {}], [{}, { identity: false }]]) {
    const f = fixture(options);
    const result = await controlledAction({ ...f.args, ...args, provider: f.provider, store: f.store });
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE'); assert.equal(f.stats().writes, 0); assert.equal(f.stats().closed, true);
  }
});

test('revocation after preflight does not write or restore', async () => {
  let valid = true;
  const f = fixture({ onRead: () => { valid = false; } });
  const result = await controlledAction({ ...f.args, sessionValid: () => valid, provider: f.provider, store: f.store });
  assert.equal(result.status, 'NOT_RUN'); assert.equal(f.stats().writes, 0); assert.equal(f.stats().closed, true);
});

test('an existing commandId is not replayed as a new timing sample', async () => {
  const f = fixture(); f.facts.push({ value: { commandId: 'new-command', status: 'unknown' } });
  await assert.rejects(controlledAction({ ...f.args, provider: f.provider, store: f.store }), /new commandId/);
  assert.equal(f.stats().writes, 0); assert.equal(f.stats().reads, 0);
});
