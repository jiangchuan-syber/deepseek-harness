// One explicitly enabled non-production lamp action. No automatic restoration.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SimpleControlLane } from './simple-control.mjs';
import { MiioLampProvider } from './miio-provider.mjs';

export async function controlledAction({ provider, store, commandId, expectedCurrentPower, targetPower,
  allowWriteTest = false, sessionValid, budgetMs = 3000, now = () => performance.now() }) {
  const report = { schemaVersion: 1, profile: 'nonproduction-lamp-action', commandId,
    goalAcceptance: 'NOT_RUN', physicalPttMeasured: false, productionEnabled: false,
    automaticRestore: false, budgetMs };
  if (!allowWriteTest) return { ...report, status: 'NOT_RUN', reason: 'explicit_write_test_disabled' };
  if (!commandId || typeof expectedCurrentPower !== 'boolean' || typeof targetPower !== 'boolean'
      || expectedCurrentPower === targetPower || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 3000
      || typeof sessionValid !== 'function') throw new Error('Invalid explicit action test');
  if (store.load().some(f => f.value?.commandId === commandId)) throw new Error('Use a new commandId; uncertain old actions require read-only reconciliation');
  const started = now();
  let lane;
  try {
    if (!sessionValid()) return { ...report, status: 'BLOCKED_SPEC', reason: 'test_window_revoked' };
    const before = await provider.readFresh({ target: 'lamp', property: 'power' }, {
      deadline: now() + budgetMs, queryId: randomUUID(), signal: new AbortController().signal });
    report.initialReadMs = now() - started;
    if (!before.fresh || before.networkIdentityVerified !== true || before.properties?.power !== expectedCurrentPower) {
      return { ...report, status: 'INSUFFICIENT_EVIDENCE', reason: 'fresh_identity_or_expected_state_mismatch' };
    }
    if (!sessionValid()) return { ...report, status: 'NOT_RUN', reason: 'test_window_revoked_after_read' };
    const guardedProvider = {
      resolve: intent => provider.resolve(intent),
      readFresh: (intent, context) => provider.readFresh(intent, context),
      write: (intent, context) => provider.write(intent, { ...context,
        isCurrent: () => sessionValid() && context.isCurrent() }),
    };
    lane = new SimpleControlLane({ provider: guardedProvider, store, capacity: 4, budgetMs, now });
    lane.offer({ requestId: commandId, text: targetPower ? '打开台灯' : '关闭台灯' });
    const fact = await lane.settled(commandId);
    const complete = fact.status === 'verified' && fact.readback?.fresh === true;
    return { ...report, status: !sessionValid() ? 'INSUFFICIENT_EVIDENCE' : complete && fact.elapsedMs <= budgetMs ? 'PASS' : 'FAIL',
      fact, softwareActionToReadbackMs: fact.elapsedMs, totalIncludingPreflightMs: now() - started,
      scope: 'software action + separate fresh protocol property only; not physical PTT or optical verification',
      restoreRequiresNewCommand: true, uncertainWriteMustNotReplay: fact.status === 'unknown' };
  } finally {
    try { await lane?.close(); }
    finally {
      await provider.close();
      report.ownerExited = provider.child === null;
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: { python: { type: 'string' }, workspace: { type: 'string' },
    'expected-lamp-hash': { type: 'string' }, 'expected-current': { type: 'string' }, target: { type: 'string' },
    'command-id': { type: 'string' }, ledger: { type: 'string' }, output: { type: 'string' },
    'session-file': { type: 'string' }, 'session-nonce': { type: 'string' }, 'allow-write-test': { type: 'boolean' } } });
  if (!values.output) throw new Error('Explicit output required');
  const disabled = values['allow-write-test'] !== true;
  if (disabled) {
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, JSON.stringify({ status: 'NOT_RUN', reason: 'explicit_write_test_disabled' }) + '\n');
    return;
  }
  for (const key of ['python', 'workspace', 'expected-lamp-hash', 'command-id', 'ledger', 'session-file', 'session-nonce']) {
    if (!values[key]) throw new Error('Missing explicit ' + key);
  }
  if (!['on', 'off'].includes(values['expected-current']) || !['on', 'off'].includes(values.target)) throw new Error('Explicit on/off states required');
  await mkdir(dirname(values.ledger), { recursive: true });
  const store = { load: () => existsSync(values.ledger) ? readFileSync(values.ledger, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [],
    append: fact => appendFileSync(values.ledger, JSON.stringify(fact) + '\n', { flush: true }) };
  const sessionValid = () => {
    try { return readFileSync(values['session-file'], 'utf8').trim() === values['session-nonce']; }
    catch { return false; }
  };
  const provider = new MiioLampProvider({ enabled: true, mode: 'execute', allowWrite: true, cooperativeControlReady: true,
    python: values.python, workspace: values.workspace, expectedLampHash: values['expected-lamp-hash'],
    operationLimitMs: 3000, startupTimeoutMs: 2000, closeTimeoutMs: 1000 });
  const report = await controlledAction({ provider, store, commandId: values['command-id'], sessionValid, allowWriteTest: true,
    expectedCurrentPower: values['expected-current'] === 'on', targetPower: values.target === 'on' });
  report.ownerExited = provider.child === null;
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, commandId: report.commandId,
    softwareActionToReadbackMs: report.softwareActionToReadbackMs, ownerExited: report.ownerExited }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
