/** Negative control of the real preload fence; no CLI, model, socket or task launch. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

test('intercepted native and Node calls retain bounded evidence without launching them', async () => {
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
  const root = await mkdtemp(join(tmpdir(), 'voice-native-fence-'));
  const require = createRequire(join(repo, 'apps/cli/package.json'));
  const esbuildRequire = createRequire(createRequire(require.resolve('tsx/package.json')).resolve('esbuild/package.json'));
  const binary = esbuildRequire.resolve('@esbuild/win32-x64/esbuild.exe');
  const module = pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local/src/index.ts')).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'userprofile', 'localappdata'].includes(name.toLowerCase())));
  Object.assign(env, { VOICE_NATIVE_FIXTURE_ROOT: root, VOICE_NATIVE_PROVIDER_PORT: '1',
    VOICE_NATIVE_ESBUILD: binary, VOICE_NATIVE_ESBUILD_SHA: createHash('sha256').update(await readFile(binary)).digest('hex'),
    VOICE_NATIVE_SUBPROCESS_MODULE: module, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json') });
  const code = `import cp from 'node:child_process';
    import assert from 'node:assert/strict';
    const { LocalSubprocessRuntime } = await import(process.env.VOICE_NATIVE_SUBPROCESS_MODULE);
    assert.throws(() => cp.spawn('public-forbidden.exe', []), /Unknown fixture child/);
    assert.throws(() => LocalSubprocessRuntime.prototype.spawn.call({}, {
      argv: ['public-forbidden.exe', 'public-argument'], cwd: process.env.VOICE_NATIVE_FIXTURE_ROOT
    }), /No task OS subprocess/);`;
  const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import',
    pathToFileURL(join(here, 'fixtures/native-brief-guard.mjs')).href, '--input-type=module', '-e', code],
  { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', expired = false;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 30000);
  let exit;
  try { exit = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })); }); }
  finally { clearTimeout(timer); }
  assert.equal(expired, false, 'Fence child exceeded its outer timeout');
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, stderr);
  const facts = JSON.parse(await readFile(join(root, 'fence.json'), 'utf8'));
  const privateFacts = JSON.parse(await readFile(join(root, 'fence-denials.private.json'), 'utf8'));
  assert.equal(facts.unknownSpawn.length, 1);
  assert.equal(facts.subprocessDenied, 1);
  assert.equal(facts.transpilerChildren.length, 0);
  assert.equal(privateFacts.length, 1);
  assert.equal(privateFacts[0].argv[0], 'public-forbidden.exe');
  assert.equal(privateFacts[0].cwd, root);
  assert.match(privateFacts[0].stack, /native-brief-guard/);
  assert.ok(privateFacts[0].stack.length <= 4096);
});
