import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MiioLampProvider } from './miio-provider.mjs';

const { values } = parseArgs({ options: { python: { type: 'string' }, workspace: { type: 'string' },
  'expected-lamp-hash': { type: 'string' }, output: { type: 'string' }, 'budget-ms': { type: 'string' },
  'startup-timeout-ms': { type: 'string' }, 'close-timeout-ms': { type: 'string' } } });
if (!values.output) throw new Error('Explicit output required');
const budgetMs = Number(values['budget-ms']);
if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Explicit positive budget required');
const provider = new MiioLampProvider({ enabled: true, mode: 'read-only', python: values.python,
  workspace: values.workspace, expectedLampHash: values['expected-lamp-hash'], operationLimitMs: budgetMs,
  startupTimeoutMs: Number(values['startup-timeout-ms']), closeTimeoutMs: Number(values['close-timeout-ms']) });
const started = performance.now(), queryId = randomUUID();
const report = { schemaVersion: 1, profile: 'nonproduction-lamp-read-only', goalAcceptance: 'NOT_RUN',
  didHash: values['expected-lamp-hash'], model: 'yeelink.light.lamp27', command: 'get_prop', propertyNames: ['power'],
  writeAttempted: false, productionChanged: false, budgetMs, clockDomain: 'node-performance.now-local',
  physicalActionOrAcousticMeasured: false };
try {
  const value = await provider.readFresh({ target: 'lamp', property: 'power' }, {
    deadline: started + budgetMs, queryId, signal: new AbortController().signal });
  Object.assign(report, { result: 'READ_OK', elapsedMs: performance.now() - started,
    fresh: value.fresh, queryIdentityMatched: value.queryId === queryId,
    networkIdentityVerified: value.networkIdentityVerified, returnedValueType: typeof value.properties.power,
    brokerReadDurationMs: value.brokerDurationMs, brokerClockId: value.brokerClockId,
    brokerDurationClock: 'python-perf_counter_ns-local' });
} catch (error) {
  Object.assign(report, { result: 'READ_FAILED', elapsedMs: performance.now() - started,
    errorCode: error.code ?? 'unexpected_provider_error', outcome: error.outcome ?? 'unknown' });
  process.exitCode = 1;
} finally {
  await provider.close();
  report.ownerExited = provider.child === null;
  report.privateStderrBytesDropped = provider.stderrBytesDropped;
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
