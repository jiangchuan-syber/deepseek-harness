import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSimpleControl, SimpleControlLane } from '../simple-control.mjs';

function fixture(overrides = {}, recovered = [], capacity = 30) {
  let clock = 0;
  const facts = structuredClone(recovered), writes = [], reads = [], properties = new Map();
  const provider = {
    resolve: intent => ({ approved: true, unique: true, homeSuffix: '3625', resourceId: intent.target,
      properties: ['power', 'brightness', 'temperature'] }),
    async write(intent, context) { writes.push({ ...intent, ...context }); properties.set(context.resourceId, { [intent.property]: intent.value }); },
    async readFresh(_intent, context) { reads.push(context); return { resourceId: context.resourceId, fresh: true,
      queryId: context.queryId, properties: properties.get(context.resourceId) }; },
    ...overrides,
  };
  const lane = new SimpleControlLane({ provider, budgetMs: 1000, capacity, now: () => clock,
    store: { load: () => facts, append: fact => facts.push(structuredClone(fact)) } });
  return { lane, provider, facts, writes, reads, properties, advance: ms => { clock += ms; } };
}

test('sequential completion exceeds admission capacity without deleting old dedup facts', async () => {
  const f = fixture({}, [], 2);
  for (let i = 0; i < 40; i++) {
    f.lane.offer({ requestId: 'sequential-' + i, voiceSessionId: 'voice-' + i, text: '开灯' });
    assert.equal((await f.lane.settled('sequential-' + i)).status, 'verified');
    assert.equal(f.lane.stats().activeAdmissions, 0);
    assert.ok(f.lane.state().length <= 2);
  }
  const original = f.lane.get('sequential-0');
  assert.equal(f.lane.stats().retainedCommands, 40); // History is retained, not claimed memory-bounded.
  f.lane.offer({ requestId: 'sequential-0', text: '开灯' });
  assert.deepEqual(f.lane.get('sequential-0'), original);
  assert.equal(f.writes.length, 40); assert.equal(f.lane.stats().activeAdmissions, 0);
  const restarted = fixture({}, f.facts, 2);
  assert.equal(restarted.lane.get('sequential-0').goalVersion, original.goalVersion);
  restarted.lane.offer({ requestId: 'sequential-0', text: '开灯' });
  assert.equal(restarted.writes.length, 0);
});

test('active budget covers queued work and releases only when its actual promise settles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ async write(intent, context) {
    if (context.commandId === 'active') await gate;
    f.properties.set(context.resourceId, { power: intent.value });
  } }, [], 2);
  try {
    f.lane.offer({ requestId: 'active', text: '开灯' }); await nextTick();
    f.lane.offer({ requestId: 'queued', text: '关灯' });
    assert.equal(f.lane.stats().activeAdmissions, 2);
    assert.throws(() => f.lane.offer({ requestId: 'overflow', text: '开风扇' }), /active-admission budget full/);
    f.lane.cancel('queued');
    assert.equal(f.lane.get('queued').status, 'cancelled');
    assert.equal(f.lane.stats().activeAdmissions, 2);
    release(); await f.lane.settled('queued');
    assert.equal(f.lane.stats().activeAdmissions, 0);
    assert.equal(f.lane.get('overflow'), undefined);
  } finally { release(); await f.lane.close(); }
});

test('preparing and failed provider work count against one budget and always release it', async () => {
  let ready = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({
    resolve: () => ({ homeSuffix: '3625', resourceId: 'lamp', properties: ['power'],
      preparationRequired: !ready, approved: ready, unique: ready }),
    async prepare() { await gate; ready = true; throw new Error('fixture-preflight-error'); },
  }, [], 1);
  try {
    f.lane.offer({ requestId: 'preparing', text: '开灯' }); await nextTick();
    assert.equal(f.lane.stats().activeAdmissions, 1);
    assert.throws(() => f.lane.offer({ requestId: 'second', text: '开灯' }), /active-admission budget full/);
    release(); assert.equal((await f.lane.settled('preparing')).status, 'rejected');
    assert.equal(f.lane.stats().activeAdmissions, 0); assert.equal(f.writes.length, 0);
    f.lane.offer({ requestId: 'second', text: '开灯' });
    assert.equal((await f.lane.settled('second')).status, 'verified');
  } finally { release(); await f.lane.close(); }
});

test('unknown recovery uses a read admission and never repeats a write', async () => {
  const original = fixture({ async write() { throw new Error('fixture-unknown-write'); },
    async readFresh() { throw new Error('fixture-read-failure'); } }, [], 1);
  original.lane.offer({ requestId: 'uncertain', text: '关灯' });
  assert.equal((await original.lane.settled('uncertain')).status, 'unknown');
  assert.equal(original.lane.stats().activeAdmissions, 0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const restored = fixture({ async readFresh(_intent, context) {
    await gate;
    return { resourceId: context.resourceId, queryId: context.queryId, fresh: true, properties: { power: false } };
  } }, original.facts, 1);
  try {
    restored.lane.offer({ requestId: 'uncertain', text: '关灯' });
    restored.lane.offer({ requestId: 'uncertain', text: '关灯' });
    assert.equal(restored.lane.stats().activeAdmissions, 1);
    assert.throws(() => restored.lane.offer({ requestId: 'new-goal', text: '开灯' }), /active-admission budget full/);
    release(); const result = await restored.lane.settled('uncertain');
    assert.equal(result.status, 'verified'); assert.equal(result.elapsedMs, null);
    assert.equal(restored.writes.length, 0); assert.equal(restored.lane.stats().activeAdmissions, 0);
  } finally { release(); await restored.lane.close(); }
});

test('closing a failed active command releases its admission without pretending success', async () => {
  const f = fixture({ write(_intent, context) {
    return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('fixture-cancelled')), { once: true }));
  } }, [], 1);
  f.lane.offer({ requestId: 'close-active', text: '开灯' }); await nextTick();
  assert.equal(f.lane.stats().activeAdmissions, 1);
  await f.lane.close();
  assert.equal(f.lane.stats().activeAdmissions, 0);
  assert.notEqual(f.lane.get('close-active').status, 'verified');
  assert.throws(() => f.lane.offer({ requestId: 'after-close', text: '开灯' }), /lane closed/);
});

test('whole-utterance grammar accepts only explicit single-target commands', () => {
  assert.deepEqual(parseSimpleControl('把台灯关掉。'), { target: 'lamp', property: 'power', value: false });
  assert.deepEqual(parseSimpleControl('请开灯！'), { target: 'lamp', property: 'power', value: true });
  assert.deepEqual(parseSimpleControl('把空调温度调到28度'), { target: 'ac', property: 'temperature', value: 28 });
  for (const text of ['不要关灯', '如果热就开空调', '明天关灯', '关灯再开风扇', '他说“关灯”', '关灯，然后等等',
    '关灯\n开空调', '看看灯是不是关了', '把台灯亮度调到-1', '把台灯亮度调到1.5', '开插座', '它关掉']) {
    assert.equal(parseSimpleControl(text), null, text);
  }
});

test('write acknowledgement needs a separate matching fresh read', async () => {
  const f = fixture();
  assert.equal(f.lane.offer({ requestId: 'one', text: '关灯' }).handled, true);
  const result = await f.lane.settled('one');
  assert.equal(result.status, 'verified'); assert.equal(result.writeAcknowledged, true);
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
  assert.equal(f.facts.find(fact => fact.value.status === 'writing').value.writeAttempted, true);
  assert.ok(result.readIssuedAt >= result.acceptedAt);
});

test('first-use async preflight verifies mapping before any write within the same budget', async () => {
  let prepared = false;
  const order = [];
  const f = fixture({
    resolve: () => ({ homeSuffix: '3625', resourceId: 'lamp', properties: ['power'],
      preparationRequired: !prepared, approved: prepared, unique: prepared }),
    async prepare() { order.push('preflight'); await nextTick(); prepared = true; },
    async write(intent) { order.push('write'); f.properties.set('lamp', { power: intent.value }); },
  });
  f.lane.offer({ requestId: 'first-use', text: '关灯' });
  assert.equal(f.lane.get('first-use').status, 'queued');
  const result = await f.lane.settled('first-use');
  assert.deepEqual(order, ['preflight', 'write']);
  assert.equal(result.status, 'verified'); assert.equal(result.preparationRequired, false);
});

test('failed, expired or superseded preflight never writes', async () => {
  for (const outcome of ['bad-mapping', 'expired', 'superseded']) {
    let prepared = false;
    const f = fixture({
      resolve: () => ({ homeSuffix: '3625', resourceId: 'lamp', properties: ['power'],
        preparationRequired: !prepared, approved: prepared && outcome !== 'bad-mapping', unique: prepared }),
      async prepare() {
        prepared = true;
        if (outcome === 'expired') f.advance(1001);
        if (outcome === 'superseded') f.lane.versions.set('lamp', 2);
      },
    });
    f.lane.offer({ requestId: outcome, text: '关灯' });
    const result = await f.lane.settled(outcome);
    assert.notEqual(result.status, 'verified'); assert.equal(result.writeAttempted, false);
    assert.equal(f.writes.length, 0);
  }
});

test('explicitly unsupported provider commands stay with the normal supervisor even at ledger capacity', async () => {
  const f = fixture();
  f.lane.capacity = 1;
  f.lane.offer({ requestId: 'supported', text: '开灯' });
  await f.lane.settled('supported');
  f.provider.resolve = () => ({ unsupported: true });
  assert.equal(f.lane.offer({ requestId: 'unsupported', text: '开风扇' }).handled, false);
  assert.equal(f.lane.state().length, 1);
});

test('invalid ranges reject without clamping and unverified identity fails closed', async () => {
  for (const text of ['台灯亮度调到0', '台灯亮度调到101', '空调温度调到15', '空调温度调到31']) {
    const f = fixture(); f.lane.offer({ requestId: 'invalid', text });
    assert.equal((await f.lane.settled('invalid')).status, 'rejected'); assert.equal(f.writes.length, 0);
  }
  for (const mapping of [null, { approved: true, unique: false }, { approved: true, unique: true, homeSuffix: 'other', resourceId: 'lamp' }]) {
    const f = fixture({ resolve: () => mapping }); f.lane.offer({ requestId: 'ambiguous', text: '关灯' });
    assert.equal((await f.lane.settled('ambiguous')).error, 'unverified_device_mapping'); assert.equal(f.writes.length, 0);
  }
});

test('repeated requestId never repeats a write and a changed payload is rejected', async () => {
  const f = fixture(); const job = { requestId: 'repeat', text: '开灯' };
  f.lane.offer(job); f.lane.offer(job); await f.lane.settled(job.requestId); f.lane.offer(job);
  assert.equal(f.writes.length, 1);
  assert.throws(() => f.lane.offer({ requestId: 'repeat', text: '关灯' }), /collision/);
});

test('different physical resources can progress together', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const started = [];
  const f = fixture({ async write(_intent, context) { started.push(context.resourceId); await barrier; } });
  f.lane.offer({ requestId: 'lamp', text: '开灯' }); f.lane.offer({ requestId: 'fan', text: '开风扇' });
  await nextTick(); assert.deepEqual(started.sort(), ['fan', 'lamp']);
  release(); await Promise.all(['lamp', 'fan'].map(id => f.lane.settled(id)));
});

test('same resource is serialized and late old facts remain marked superseded', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); const order = [];
  const f = fixture({ async write(intent, context) {
    order.push(context.commandId); if (context.commandId === 'old') await barrier;
    f.properties.set(context.resourceId, { power: intent.value });
  } });
  f.lane.offer({ requestId: 'old', text: '开灯' }); await nextTick();
  f.lane.offer({ requestId: 'new', text: '关灯' }); await nextTick(); assert.deepEqual(order, ['old']);
  release(); await f.lane.settled('new');
  assert.deepEqual(order, ['old', 'new']); assert.equal(f.lane.get('old').currentGoal, false);
  assert.equal(f.lane.get('old').status, 'verified'); assert.equal(f.lane.get('new').status, 'verified');
});

test('queued obsolete target is skipped before any write', async () => {
  const f = fixture(); f.lane.offer({ requestId: 'old', text: '开灯' }); f.lane.offer({ requestId: 'new', text: '关灯' });
  await f.lane.settled('new'); assert.equal(f.lane.get('old').status, 'superseded'); assert.equal(f.writes.length, 1);
});

test('a rejected parameter does not supersede a valid pending target', async () => {
  const f = fixture(); f.lane.offer({ requestId: 'valid', text: '开灯' });
  f.lane.offer({ requestId: 'invalid', text: '台灯亮度调到101' });
  assert.equal((await f.lane.settled('valid')).status, 'verified'); assert.equal(f.writes.length, 1);
});

test('stale readback, wrong identity and protocol ok are not verification', async () => {
  for (const patch of [{ fresh: false }, { resourceId: 'other' }, { properties: { power: true } }, { queryId: '' }]) {
    const f = fixture({ readFresh: async (_intent, context) => ({ resourceId: 'lamp', fresh: true, queryId: context.queryId, properties: { power: false }, ...patch }) });
    f.lane.offer({ requestId: 'not-confirmed', text: '关灯' });
    assert.equal((await f.lane.settled('not-confirmed')).status, 'unknown');
  }
});

test('unknown write is read back without retrying its side effect', async () => {
  let attempts = 0;
  const f = fixture({ async write(intent, context) { attempts++; f.properties.set(context.resourceId, { power: intent.value }); throw new Error('ack lost'); } });
  f.lane.offer({ requestId: 'ack-lost', text: '关灯' }); const result = await f.lane.settled('ack-lost');
  assert.equal(attempts, 1); assert.equal(result.writeAcknowledged, false); assert.equal(result.status, 'verified');
  assert.equal(f.reads.length, 1);
});

test('a provider refusal before transmission cannot become a verified action', async () => {
  const f = fixture({ async write() { throw Object.assign(new Error('write disabled'), { outcome: 'not_started', code: 'actuation_disabled' }); } });
  f.lane.offer({ requestId: 'not-authorized', text: '关灯' });
  const result = await f.lane.settled('not-authorized');
  assert.equal(result.status, 'rejected'); assert.equal(result.writeAttempted, false);
  assert.equal(result.error, 'actuation_disabled'); assert.equal(f.reads.length, 0);
});

test('expired write remains unknown, and expired queued work never writes', async () => {
  const f = fixture({ async write() { f.advance(1001); } });
  f.lane.offer({ requestId: 'expired-write', text: '开灯' });
  assert.equal((await f.lane.settled('expired-write')).status, 'unknown'); assert.equal(f.reads.length, 0);
  const queued = fixture(); queued.lane.offer({ requestId: 'expired-queue', text: '开灯' }); queued.advance(1001);
  assert.equal((await queued.lane.settled('expired-queue')).status, 'cancelled'); assert.equal(queued.writes.length, 0);
});

test('deadline during read cannot turn a late matching result into success', async () => {
  const f = fixture({ async readFresh(_intent, context) { f.advance(1001); return { resourceId: 'lamp', fresh: true, queryId: context.queryId, properties: { power: false } }; } });
  f.lane.offer({ requestId: 'late-read', text: '关灯' });
  assert.equal((await f.lane.settled('late-read')).status, 'unknown');
});

test('cancel during a possible write is unknown, never a verified cancellation', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture({ async write() { await barrier; } });
  f.lane.offer({ requestId: 'cancel-write', text: '开灯' }); await nextTick(); f.lane.cancel('cancel-write');
  assert.equal(f.lane.get('cancel-write').status, 'writing'); release();
  assert.equal((await f.lane.settled('cancel-write')).status, 'unknown'); assert.equal(f.reads.length, 0);
});

test('recovery reconciles an uncertain previous write without replaying it', async () => {
  const f = fixture({}, [{ kind: 'control.snapshot', value: { commandId: 'crashed', intent: { target: 'lamp', property: 'power', value: false },
    resourceId: 'lamp', goalVersion: 1, status: 'writing', acceptedAt: 123, clockId: 'previous-process', writeAttempted: true } }]);
  f.properties.set('lamp', { power: false }); f.lane.offer({ requestId: 'crashed', text: '关灯' });
  const result = await f.lane.settled('crashed');
  assert.equal(result.status, 'verified'); assert.equal(result.originalLatencyUnknown, true); assert.equal(result.elapsedMs, null);
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 1);
});

test('a fresh process reads a flushed on-disk ledger after the writer exits before acknowledgement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-control-crash-'));
  t.after(() => { assert.equal(dirname(dir), tmpdir()); rmSync(dir, { recursive: true, force: true }); });
  const ledger = join(dir, 'ledger.jsonl'), state = join(dir, 'fake-device.json');
  const source = `import { appendFileSync, writeFileSync } from 'node:fs';
    import { SimpleControlLane } from ${JSON.stringify(new URL('../simple-control.mjs', import.meta.url).href)};
    const lane = new SimpleControlLane({ budgetMs: 1000, capacity: 4,
      store: { load: () => [], append: fact => appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(fact) + '\\n', { flush: true }) },
      provider: { resolve: () => ({ approved: true, unique: true, homeSuffix: '3625', resourceId: 'lamp', properties: ['power'] }),
        async write() { writeFileSync(${JSON.stringify(state)}, JSON.stringify({ power: false })); process.exit(23); },
        async readFresh() { throw new Error('must exit first'); } } });
    lane.offer({ requestId: 'process-crash', text: '关灯' });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 23, child.stderr);
  const persisted = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(persisted.at(-1).value.status, 'writing');
  const f = fixture({ async readFresh(_intent, context) { return { resourceId: 'lamp', queryId: context.queryId, fresh: true,
    properties: JSON.parse(readFileSync(state, 'utf8')) }; } }, persisted);
  f.lane.offer({ requestId: 'process-crash', text: '关灯' }); const result = await f.lane.settled('process-crash');
  assert.equal(result.status, 'verified'); assert.equal(f.writes.length, 0);
  assert.equal(result.elapsedMs, null); assert.equal(result.originalLatencyUnknown, true);
  assert.notEqual(result.clockId, result.originalClockId);
});
