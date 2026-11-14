/** Negative control of the real preload fence; no CLI, model, socket or task launch. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { gitReadRule, gitReadPath, gitReadArgs } from './fixtures/native-brief-git-rule.mjs';
import { runnerReadRule, runnerNodePath } from './fixtures/native-brief-runner-rule.mjs';
import { isOwnedStop, bindOwnedStop } from './fixtures/native-brief-policy.mjs';
import { Context } from '@deepseek-ai/cordis';

test('private stop IPC rejects wrong owner and malformed messages', () => {
  const nonce = 'public-owner-12345678';
  assert.equal(isOwnedStop({ type: 'voice-native-fixture-stop', nonce }, nonce), true);
  assert.equal(isOwnedStop({ type: 'voice-native-fixture-stop', nonce: 'other' }, nonce), false);
  assert.equal(isOwnedStop({ type: 'voice-native-fixture-stop', nonce, extra: true }, nonce), false);
  assert.equal(isOwnedStop(null, nonce), false);
  assert.equal(isOwnedStop(['voice-native-fixture-stop', nonce], nonce), false);
  assert.equal(isOwnedStop({ type: 'voice-native-fixture-stop', nonce }, undefined), false);
});

test('real Cordis disposal removes only its owned IPC listener', async () => {
  const ctx = new Context(), nonce = 'public-owner-12345678';
  const before = process.listenerCount('message'); let stops = 0, cleanups = 0;
  bindOwnedStop(ctx, nonce, () => { stops++; }, () => { cleanups++; });
  try {
    assert.equal(process.listenerCount('message'), before + 1);
    process.emit('message', { type: 'voice-native-fixture-stop', nonce: 'other-owner' });
    assert.equal(stops, 0);
  } finally { await ctx.fiber.dispose(); }
  assert.equal(process.listenerCount('message'), before);
  assert.equal(cleanups, 1);
  process.emit('message', { type: 'voice-native-fixture-stop', nonce });
  assert.equal(stops, 0);
});

test('intercepted native and Node calls retain bounded evidence without launching them', { skip: process.platform !== 'win32' }, async () => {
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
  const root = await mkdtemp(join(tmpdir(), 'voice-native-fence-'));
  await mkdir(join(root, 'workspace'));
  const require = createRequire(join(repo, 'apps/cli/package.json'));
  const esbuildRequire = createRequire(createRequire(require.resolve('tsx/package.json')).resolve('esbuild/package.json'));
  const binary = esbuildRequire.resolve('@esbuild/win32-x64/esbuild.exe');
  const module = pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local/src/index.ts')).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['systemroot', 'windir', 'path', 'temp', 'tmp', 'comspec', 'pathext', 'userprofile', 'localappdata'].includes(name.toLowerCase())));
  Object.assign(env, { VOICE_NATIVE_FIXTURE_ROOT: root, VOICE_NATIVE_PROVIDER_PORT: '1',
    VOICE_NATIVE_REPO: repo,
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
  assert.equal(privateFacts.length, 2);
  assert.equal(privateFacts[0].api, 'node.spawn');
  assert.equal(privateFacts[0].argv[0], 'public-forbidden.exe');
  const runtime = privateFacts.find(item => item.api === 'spawn');
  assert.equal(runtime.argv[0], 'public-forbidden.exe');
  assert.equal(runtime.cwd, root);
  assert.match(runtime.stack, /native-brief-guard/);
  assert.ok(privateFacts.every(item => item.stack.length <= 4096));
});

test('provider bootstrap accepts only its exact hashed source invocation and owned Git spec', { skip: process.platform !== 'win32' }, async () => {
  const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../..');
  const root = await mkdtemp(join(tmpdir(), 'voice-native-runner-rule-'));
  const owned = join(root, 'workspace'); await mkdir(owned);
  const require = createRequire(join(repo, 'packages/subprocess/subprocess-local/package.json'));
  const spec = { argv: [gitReadPath, ...gitReadArgs], cwd: owned };
  const args = ['--import', pathToFileURL(require.resolve('tsx/esm')).href,
    join(repo, 'packages/subprocess/subprocess-local/src/bin.ts'), '--', ...spec.argv];
  const options = { cwd: owned, env: { DSH_SUBPROCESS_RUNNER: 'windows' } };
  const allowed = runnerReadRule(repo, owned);
  assert.equal(allowed(runnerNodePath, args, options, spec), true);
  assert.equal(allowed(runnerNodePath, ['-e', 'public'], options, spec), false);
  assert.equal(allowed(runnerNodePath, args.map((v, i) => i === 2 ? 'public-other-script.ts' : v), options, spec), false);
  assert.equal(allowed(runnerNodePath, [...args, '--help'], options, spec), false);
  assert.equal(allowed(runnerNodePath, args, { ...options, cwd: root }, spec), false);
  assert.equal(allowed(runnerNodePath, args, { ...options, env: {} }, spec), false);
  assert.equal(allowed(runnerNodePath, args, options, { ...spec, argv: [gitReadPath, 'status'] }), false);
});

test('the installed Git read rule rejects altered argv, cwd and binary', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-native-git-rule-'));
  const owned = join(root, 'workspace'); await mkdir(owned);
  const allowed = gitReadRule(owned);
  const spec = { argv: [gitReadPath, ...gitReadArgs], cwd: owned };
  assert.equal(allowed(spec), true);
  assert.equal(allowed({ ...spec, argv: [gitReadPath.replace('.exe', '.EXE'), ...gitReadArgs] }), true);
  assert.equal(allowed({ ...spec, argv: [gitReadPath, 'status'] }), false);
  assert.equal(allowed({ ...spec, argv: spec.argv.slice(0, -1) }), false);
  assert.equal(allowed({ ...spec, argv: [...spec.argv, '--help'] }), false);
  assert.equal(allowed({ ...spec, argv: ['public-forbidden.exe', ...gitReadArgs] }), false);
  assert.equal(allowed({ ...spec, cwd: root }), false);
});
