import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MiioLampProvider } from '../miio-provider.mjs';
import { SimpleControlLane } from '../simple-control.mjs';
import { createControlProvider } from '../control-provider.mjs';

const python = process.env.VOICE_CONTROL_TEST_PYTHON ?? 'python';
const intent = { target: 'lamp', property: 'power', value: false };
const context = (ms = 2000, extra = {}) => ({ deadline: performance.now() + ms, queryId: randomUUID(),
  signal: new AbortController().signal, isCurrent: () => true, ...extra });
const writeContext = (provider, extra = {}) => context(1000, { commandId: randomUUID(), goalVersion: 1,
  resourceId: provider.ready.resourceId, ...extra });
async function fixture(t, patch = {}, state = { power: true }) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-miio-fixture-'));
  await mkdir(join(dir, 'server/data'), { recursive: true });
  const home = randomUUID() + '3625', did = '123456789';
  const expectedLampHash = createHash('sha256').update(did).digest('hex').slice(0, 16);
  await writeFile(join(dir, 'server/data/xiaomi-tokens.json'), JSON.stringify([{ homes: [{ home_id: home,
    devices: [{ model: 'yeelink.light.lamp27', did, localip: '127.0.0.1', token: 'synthetic-fixture-token' }] }] }]));
  const stateFile = join(dir, 'fake-state.json'); await writeFile(stateFile, JSON.stringify(state));
  const config = { enabled: true, python, workspace: dir, expectedLampHash, operationLimitMs: 3000,
    startupTimeoutMs: 2000, closeTimeoutMs: 1000, fixture: stateFile, ...patch };
  const providers = [];
  const provider = new MiioLampProvider(config); providers.push(provider);
  t.after(async () => {
    for (const owned of providers) await owned.close();
    assert.equal(dirname(dir), resolve(tmpdir())); assert.ok(basename(dir).startsWith('voice-miio-fixture-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, stateFile, config, provider, makeProvider(extra = {}) {
    const p = new MiioLampProvider({ ...config, ...extra }); providers.push(p); return p;
  }, state: async () => JSON.parse(await readFile(stateFile, 'utf8')) };
}

test('provider is disabled by default and cannot launch or send an actuator request', async () => {
  const p = new MiioLampProvider({});
  await assert.rejects(p.start(), /provider_disabled/);
  await assert.rejects(p.write(intent, context()), /actuation_disabled/);
  assert.equal(p.child, null); await p.close();
});

test('configured factory is lazy and first control command performs a real fixture preflight', async t => {
  const f = await fixture(t, { mode: 'execute', allowWrite: true, cooperativeControlReady: true });
  const provider = createControlProvider({ ...f.config, kind: 'miio-lamp' });
  try {
    assert.equal(provider.child, null); assert.equal(provider.ready, null);
    const facts = [];
    const lane = new SimpleControlLane({ provider, budgetMs: 2500, capacity: 4,
      store: { load: () => [], append: value => facts.push(value) } });
    lane.offer({ requestId: 'factory-first-use', voiceSessionId: 'public-fixture-voice', text: '关灯' });
    const result = await lane.settled('factory-first-use');
    assert.equal(result.status, 'verified'); assert.equal(result.preparationRequired, false);
    assert.equal((await f.state()).writes, 1);
    assert.equal(facts[0].value.writeAttempted, false);
    assert.equal(result.readback.resourceId, provider.ready.resourceId);
    await lane.close();
  } finally { await provider.close(); }
});

test('read-only provider pins private inventory and echoes only a fresh query identity', async t => {
  const f = await fixture(t); const ready = await f.provider.start();
  const ctx = context(); const result = await f.provider.readFresh(intent, ctx);
  assert.equal(result.queryId, ctx.queryId); assert.equal(result.fresh, true);
  assert.equal(result.properties.power, true); assert.equal(result.resourceId, ready.resourceId);
  assert.equal(result.physicalEffectVerified, false); assert.equal(result.networkIdentityVerified, false);
  assert.equal(result.fixtureOnly, true);
  assert.equal(f.provider.resolve(intent).approved, false);
  await assert.rejects(f.provider.write(intent, context()), /actuation_disabled/);
  assert.equal((await f.state()).writes, undefined);
  assert.ok(!JSON.stringify(ready).includes('synthetic-fixture-token'));
  assert.ok(!JSON.stringify(ready).includes('127.0.0.1'));
});

test('another process cannot take ownership of the same actual home', async t => {
  const f = await fixture(t); await f.provider.start();
  await assert.rejects(f.makeProvider().start(), /control_owner_busy/);
  assert.equal((await f.provider.readFresh(intent, context())).fresh, true);
});

test('identity changed in private inventory fails closed before network or actuation', async t => {
  const f = await fixture(t, { expectedLampHash: '0000000000000000' });
  await assert.rejects(f.provider.start(), /lamp_identity_changed/);
  assert.equal((await f.state()).writes, undefined);
});

test('execute mode requires a declared cooperative path and a preflight fresh read', async t => {
  assert.throws(() => new MiioLampProvider({ enabled: true, python, workspace: '.', expectedLampHash: '0000000000000000',
    mode: 'execute', operationLimitMs: 1000, startupTimeoutMs: 1000, closeTimeoutMs: 1000, allowWrite: true }), /cooperative_write_path_not_ready/);
  const f = await fixture(t, { mode: 'execute', allowWrite: true, cooperativeControlReady: true });
  await f.provider.start(); await assert.rejects(f.provider.write(intent, context()), /actuation_disabled/);
  await f.provider.readFresh(intent, context());
  await f.provider.write(intent, writeContext(f.provider));
  assert.equal((await f.state()).writes, 1);
  assert.equal((await f.provider.readFresh(intent, context())).properties.power, false);
});

test('a superseded goal is denied at the ready-to-write handoff', async t => {
  const f = await fixture(t, { mode: 'execute', allowWrite: true, cooperativeControlReady: true });
  await f.provider.readFresh(intent, context());
  await assert.rejects(f.provider.write(intent, writeContext(f.provider, { isCurrent: () => false })), error => {
    assert.equal(error.code, 'write_not_authorized'); assert.equal(error.outcome, 'not_started'); return true;
  });
  assert.equal((await f.state()).writes, undefined);
});

test('queued expiry does not kill another active read or later execute the expired job', async t => {
  const f = await fixture(t, {}, { power: true, readDelayMs: 150 }); await f.provider.start();
  const first = f.provider.readFresh(intent, context(1000));
  const second = f.provider.readFresh(intent, context(30));
  await assert.rejects(second, error => error.outcome === 'not_started');
  assert.equal((await first).properties.power, true);
  assert.ok(f.provider.ready); assert.equal((await f.state()).writes, undefined);
});

test('an unknown write kills and awaits its one owner; disk-ledger recovery only reads', async t => {
  const f = await fixture(t, { mode: 'execute', allowWrite: true, cooperativeControlReady: true },
    { power: true, afterWriteDelayMs: 1500 });
  await f.provider.readFresh(intent, context());
  const ledger = join(f.dir, 'control-ledger.jsonl');
  await writeFile(ledger, '');
  const store = { load: () => readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    append: fact => appendFileSync(ledger, JSON.stringify(fact) + '\n', { flush: true }) };
  const lane = new SimpleControlLane({ provider: f.provider, budgetMs: 500, capacity: 4, store });
  lane.offer({ requestId: 'one-real-fake-write', text: '关灯' });
  const unknown = await lane.settled('one-real-fake-write');
  assert.equal(unknown.status, 'unknown'); assert.equal((await f.state()).writes, 1);
  assert.equal(f.provider.child, null);
  const recovered = new SimpleControlLane({ provider: f.provider, budgetMs: 2000, capacity: 4, store });
  recovered.offer({ requestId: 'one-real-fake-write', text: '关灯' });
  const checked = await recovered.settled('one-real-fake-write');
  assert.equal(checked.status, 'verified'); assert.equal(checked.elapsedMs, null);
  assert.equal(checked.originalLatencyUnknown, true); assert.equal((await f.state()).writes, 1);
  await recovered.close(); await lane.close();
});

test('the private SDK adapter bounds discovery, pins identity and refuses expired sends', () => {
  const source = fileURLToPath(new URL('./test_miio_deadline.py', import.meta.url));
  const child = spawnSync(python, [source], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stderr.includes('Ran 3 tests'));
});
