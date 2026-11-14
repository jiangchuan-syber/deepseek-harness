/** Exact source-mode Windows Job bootstrap for the reviewed Git read only. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitReadRule } from './native-brief-git-rule.mjs';

export const runnerNodePath = 'C:/Program Files/nodejs/node.exe';
const nodeSha = 'f8d22c62786c547dc76b15c744e86c0ac1fe9dc38f2e0610dbad4d2b223a4544';
const tsxSha = '206f38b4bddcbc686dab39ff37df516eedfb1b2d58afbc3c47ea5b9417d3ad54';
const runnerSha = '2f4ed2f5b9a08d8b828a73c81f82ed3a9416787e73c3d50acf6c50f71884010f';

/** Bind the real provider's fixed bootstrap and the separately approved target spec. */
export function runnerReadRule(repo, cwd) {
  const require = createRequire(join(repo, 'packages/subprocess/subprocess-local/package.json'));
  const tsx = require.resolve('tsx/esm'), runner = join(repo, 'packages/subprocess/subprocess-local/src/bin.ts');
  const fingerprint = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const canonical = file => { const value = realpathSync(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
  const expectedNode = canonical(runnerNodePath), expectedCwd = canonical(cwd);
  const targetAllowed = gitReadRule(cwd);
  const unchanged = () => fingerprint(runnerNodePath) === nodeSha && fingerprint(tsx) === tsxSha && fingerprint(runner) === runnerSha;
  if (!unchanged()) throw new Error('Reviewed fixture provider bootstrap changed');
  const prefix = ['--import', pathToFileURL(tsx).href, runner, '--'];
  return (command, args, options, spec) => {
    try {
      return targetAllowed(spec) && unchanged() && canonical(command) === expectedNode
        && canonical(options.cwd) === expectedCwd && options.env?.DSH_SUBPROCESS_RUNNER === 'windows'
        && Array.isArray(args) && args.length === 10
        && prefix.every((arg, index) => args[index] === arg)
        && spec.argv.every((arg, index) => args[index + prefix.length] === arg);
    } catch { return false; }
  };
}
