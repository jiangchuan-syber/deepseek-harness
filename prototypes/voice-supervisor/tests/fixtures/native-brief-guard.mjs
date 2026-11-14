/** Fixture process fence, not an OS sandbox or a replacement Agent/runtime. */
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve, join } from 'node:path';

const root = process.env.VOICE_NATIVE_FIXTURE_ROOT;
const facts = { unknownSpawn: [], deniedNetwork: 0, transpilerChildren: [], subprocessDenied: 0 };
const denials = [];
const save = () => writeFileSync(join(root, 'fence.json'), JSON.stringify(facts, null, 2));
const binary = resolve(process.env.VOICE_NATIVE_ESBUILD);
if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== process.env.VOICE_NATIVE_ESBUILD_SHA) throw new Error('Fixture transpiler identity changed');
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  if (resolve(command) !== binary || !Array.isArray(args) || args.join('|') !== '--service=0.28.1|--ping') {
    facts.unknownSpawn.push({ executable: basename(command), argumentCount: args?.length ?? 0 }); save();
    throw new Error('Unknown fixture child launch; stop and review');
  }
  const child = spawn(command, args, options);
  const owned = { pid: child.pid, exited: false }; facts.transpilerChildren.push(owned); save();
  child.once('exit', () => { owned.exited = true; save(); }); return child;
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork']) cp[name] = () => {
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
for (const name of ['spawn', 'spawnTerminal']) LocalSubprocessRuntime.prototype[name] = spec => {
  facts.subprocessDenied++;
  if (denials.length < 16) denials.push({ api: name,
    argv: Array.isArray(spec?.argv) ? spec.argv.slice(0, 24).map(arg => String(arg).slice(0, 256)) : null,
    cwd: typeof spec?.cwd === 'string' ? spec.cwd.slice(0, 512) : null,
    stack: new Error('Denied subprocess call').stack?.slice(0, 4096) });
  writeFileSync(join(root, 'fence-denials.private.json'), JSON.stringify(denials, null, 2));
  save(); throw new Error('No task OS subprocess is allowed in this native structure fixture');
};
