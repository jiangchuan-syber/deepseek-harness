/** Process-only fixture: the real outer HTTP runner and plugin remain unchanged. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, Type, DEFAULT_SCHEMA } from 'js-yaml';
import { setTimeout as delay } from 'node:timers/promises';

const fixtureRoot = resolve(process.env.VOICE_OUTER_FIXTURE_ROOT ?? 'missing-fixture-root');
const fixtureState = join(fixtureRoot, 'broker-state.json');
const evidencePath = join(fixtureRoot, 'native-boundary.json');
const broker = resolve(dirname(fileURLToPath(import.meta.url)), '../../miio-lamp-broker.py');
const originalSpawn = childProcess.spawn;
const originalFetch = globalThis.fetch;
const evidence = { boundary: 'native launcher and LLM only', launches: 0, brokerLaunches: 0,
  quickRequests: [], injections: [], steers: 0, publicNetworkAttempts: 0, blockedSpawns: 0 };
let nativePort;
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const refuse = message => { evidence.blockedSpawns++; save(); throw new Error(message); };
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== nativePort) {
    evidence.publicNetworkAttempts++; save(); throw new Error('Fixture denied non-owned fetch');
  }
  if (url.pathname === '/events' && existsSync(join(fixtureRoot, 'hold-events'))) return (async () => {
    writeFileSync(join(fixtureRoot, 'events-held'), 'fixture-only');
    while (existsSync(join(fixtureRoot, 'hold-events'))) {
      options?.signal?.throwIfAborted(); await delay(10);
    }
    return originalFetch(input, options);
  })();
  return originalFetch(input, options);
};
childProcess.spawn = function(command, args, options = {}) {
  const native = command === process.execPath && Array.isArray(args)
    && args[0] === '--import' && args[1] === 'tsx/esm' && args[2] === 'apps/cli/src/bin.ts'
    && args[3] === '--profile' && args[4] === 'web' && args[5] === '--patch'
    && args.slice(7).join('|') === '--no-open|--host|127.0.0.1|--port|0';
  if (!native) {
    const fixtureIndex = args?.indexOf('--fixture') ?? -1;
    if (command === process.env.VOICE_CONTROL_TEST_PYTHON && resolve(args?.[0] ?? '') === broker
        && fixtureIndex > 0 && resolve(args[fixtureIndex + 1]) === fixtureState
        && args.includes('--workspace') && resolve(args[args.indexOf('--workspace') + 1]) === fixtureRoot) {
      evidence.brokerLaunches++; save(); return originalSpawn(command, args, options);
    }
    return refuse('Fixture denied unrecognized child launch');
  }
  if (++evidence.launches !== 1 || resolve(args[6]) !== join(fixtureRoot, 'run', 'overlay.yml')) {
    return refuse('Fixture denied repeated or unexpected native boundary');
  }
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let dispose, disposed = false;
  child.kill = () => {
    if (disposed) return true;
    disposed = true;
    void Promise.resolve().then(() => dispose?.()).then(() => {
      child.stdout.end(); child.stderr.end(); save(); child.emit('exit', 0, null);
    }, error => { child.stderr.end(error.name); save(); child.emit('exit', 1, null); });
    return true;
  };
  queueMicrotask(async () => {
    try {
      // This parser intentionally covers only this prototype's generated overlay,
      // not Cordis bootstrap/session persistence. Reject unknown executable tags.
      const js = new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct(expression) {
        const allowed = ['process.env.VOICE_MODEL', 'process.env.VOICE_LAB_TOKEN',
          'process.env.VOICE_LAB_READY_FILE', 'process.env.VOICE_LAB_CWD',
          `JSON.parse(process.env.VOICE_SIMPLE_CONTROL_CONFIG ?? '{"enabled":false}')`];
        if (!allowed.includes(expression)) throw new Error('Unexpected fixture overlay expression');
        return expression.startsWith('JSON.parse') ? JSON.parse(options.env.VOICE_SIMPLE_CONTROL_CONFIG ?? '{"enabled":false}')
          : options.env[expression.slice('process.env.'.length)];
      } });
      const entries = load(readFileSync(args[6], 'utf8'), { schema: DEFAULT_SCHEMA.extend([js]) });
      const plugin = entries.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'voice-supervisor-lab');
      if (resolve(plugin?.name ?? '') !== resolve(dirname(broker), 'plugin.mjs')) throw new Error('Unexpected plugin identity');
      const idleRejectors = [];
      const parent = { id: 'outer-fixture-native-parent', status: 'running',
        session: { snapshotEvents: () => [] }, model: { select() {} },
        ctx: { systemPrompt: { section: () => () => {} }, tools: { restrict: () => () => {} } },
        whenIdle: () => new Promise((_resolve, reject) => idleRejectors.push(reject)),
        cancel() { for (const reject of idleRejectors.splice(0)) reject(new Error('Owned fixture shutdown')); },
        inject(message) { evidence.injections.push(message); save(); },
        steer() { evidence.steers++; save(); throw new Error('Simple control reached Max'); } };
      const ctx = { workspaceRegistry: { create: async () => ({ id: 'outer-fixture-workspace' }) },
        sessionController: { create: async () => ({ sessionId: parent.id }) }, agents: { get: () => parent },
        effect(fn) { fn(); }, on(kind, fn) { if (kind === 'dispose') dispose = fn; },
        llm: { async *stream(request) {
          evidence.quickRequests.push({ reasoningEffort: request.reasoningEffort,
            tools: request.tools, system: request.system, messages: request.messages }); save();
          yield { type: 'text-delta', text: '好的，我来处理。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } } };
      const { apply } = await import(pathToFileURL(plugin.name).href);
      await apply(ctx, plugin.config);
      nativePort = JSON.parse(readFileSync(plugin.config.readyFile, 'utf8')).port;
      writeFileSync(join(fixtureRoot, 'native-client.private.json'), JSON.stringify({
        url: 'http://127.0.0.1:' + nativePort, token: plugin.config.token }));
      save();
    } catch (error) {
      evidence.errorType = error.name; evidence.error = error.message; save();
      child.stderr.end(error.stack); child.emit('exit', 1, null);
    }
  });
  return child;
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
  childProcess[name] = () => refuse('Fixture denied additional process API');
}
syncBuiltinESMExports();
