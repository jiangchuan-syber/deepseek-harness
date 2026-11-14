/** Fixture process fence, not an OS sandbox or a replacement Agent/runtime. */
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { gitReadRule } from './native-brief-git-rule.mjs';
import { runnerReadRule } from './native-brief-runner-rule.mjs';

const root = process.env.VOICE_NATIVE_FIXTURE_ROOT;
const facts = { unknownSpawn: [], deniedNetwork: 0, transpilerChildren: [], subprocessDenied: 0, expectedStartupReads: [] };
const denials = [];
const save = () => writeFileSync(join(root, 'fence.json'), JSON.stringify(facts, null, 2));
const allowedRead = gitReadRule(join(root, 'workspace'));
const allowedRunner = runnerReadRule(process.env.VOICE_NATIVE_REPO, join(root, 'workspace'));
let startupSpec;
const startupEvidence = [];
function retainDenial(api, argv, cwd) {
  if (denials.length < 16) denials.push({ api,
    argv: Array.isArray(argv) ? argv.slice(0, 24).map(arg => String(arg).slice(0, 256)) : null,
    cwd: typeof cwd === 'string' ? cwd.slice(0, 512) : null,
    stack: new Error('Denied subprocess call').stack?.slice(0, 4096) });
  writeFileSync(join(root, 'fence-denials.private.json'), JSON.stringify(denials, null, 2));
}
const binary = resolve(process.env.VOICE_NATIVE_ESBUILD);
if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== process.env.VOICE_NATIVE_ESBUILD_SHA) throw new Error('Fixture transpiler identity changed');
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (startupSpec && facts.expectedStartupReads.length < 8 && allowedRunner(command, args, options, startupSpec)) {
    startupEvidence.push({ command, args, cwd: options.cwd, validated: true });
    writeFileSync(join(root, 'fence-expected-startup.private.json'), JSON.stringify(startupEvidence, null, 2));
    const child = spawn(command, args, options);
    const entry = { layer: 'node', command: 'reviewed-windows-job-git-bootstrap', pid: child.pid, settled: false, directChildExited: false };
    facts.expectedStartupReads.push(entry); save();
    child.once('exit', exitCode => { entry.exitCode = exitCode; entry.settled = true; entry.directChildExited = true; save(); });
    return child;
  }
  if (facts.expectedStartupReads.length < 8 && allowedRead({ argv: [command, ...(args ?? [])], cwd: options?.cwd })) {
    const child = spawn(command, args, options);
    const entry = { layer: 'node', command: 'reviewed-git-workspace-location', pid: child.pid, settled: false, directChildExited: false };
    facts.expectedStartupReads.push(entry); save();
    child.once('exit', exitCode => { entry.exitCode = exitCode; entry.settled = true; entry.directChildExited = true; save(); });
    return child;
  }
  if (resolve(command) !== binary || !Array.isArray(args) || args.join('|') !== '--service=0.28.1|--ping') {
    retainDenial('node.spawn', [command, ...(args ?? [])], options?.cwd);
    facts.unknownSpawn.push({ executable: basename(command), argumentCount: args?.length ?? 0 }); save();
    throw new Error('Unknown fixture child launch; stop and review');
  }
  const child = spawn(command, args, options);
  const owned = { pid: child.pid, exited: false }; facts.transpilerChildren.push(owned); save();
  child.once('exit', () => { owned.exited = true; save(); }); return child;
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork']) cp[name] = (...args) => {
  retainDenial('node.' + name, args.filter(value => typeof value === 'string'), undefined);
  facts.unknownSpawn.push({ api: name }); save(); throw new Error('Unknown fixture process API; stop and review');
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== process.env.VOICE_NATIVE_PROVIDER_PORT) {
    facts.deniedNetwork++; save(); throw new Error('Fixture denied non-owned provider request');
  }
  return fetch(input, options);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = typeof first === 'object' && first !== null ? first.port : first;
  const host = typeof first === 'object' && first !== null ? first.host : args[1];
  if (String(port) !== process.env.VOICE_NATIVE_PROVIDER_PORT || host !== '127.0.0.1') {
    facts.deniedNetwork++; save(); throw new Error('Fixture denied non-owned socket');
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports(); save();
// Cover the real Windows native service too, not only node:child_process.
const { LocalSubprocessRuntime } = await import(process.env.VOICE_NATIVE_SUBPROCESS_MODULE);
const runtimeSpawn = LocalSubprocessRuntime.prototype.spawn;
for (const name of ['spawn', 'spawnTerminal']) LocalSubprocessRuntime.prototype[name] = function(spec) {
  if (name === 'spawn' && facts.expectedStartupReads.length < 8 && allowedRead(spec)) {
    const entry = { layer: 'runtime', command: 'reviewed-git-workspace-location', settled: false, rangeEmpty: false };
    facts.expectedStartupReads.push(entry); save();
    let handle;
    startupSpec = spec;
    try { handle = runtimeSpawn.call(this, spec); }
    finally { startupSpec = undefined; }
    void handle.done.then(async outcome => {
      entry.exitCode = outcome.exitCode;
      entry.rangeEmpty = await handle.waitForExit();
      entry.settled = true; save();
    }).catch(error => { entry.errorType = error.name; save(); });
    return handle;
  }
  facts.subprocessDenied++;
  retainDenial(name, spec?.argv, spec?.cwd);
  save(); throw new Error('No task OS subprocess is allowed in this native structure fixture');
};
