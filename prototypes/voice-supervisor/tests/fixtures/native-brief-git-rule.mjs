/** One observed Windows Git read used by the real workspace-changes plugin. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';

export const gitReadArgs = Object.freeze(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects']);
export const gitReadPath = 'C:/Program Files/Git/cmd/git.exe';
export const gitReadSha = '757d9cf224634cb2a5b8ead077c1b2d572ef4c329908c1554cd80f7e8c4db96e';

/** Bind the exact installed binary, complete argv and owned cwd; no command runs here. */
export function gitReadRule(cwd) {
  const expectedCwd = realpathSync(cwd), executable = realpathSync(gitReadPath);
  const fingerprint = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const sameRealPath = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (fingerprint(executable) !== gitReadSha) throw new Error('Reviewed fixture Git binary changed');
  return spec => {
    try {
      return Array.isArray(spec?.argv) && spec.argv.length === 6
        && spec.argv.slice(1).every((arg, index) => arg === gitReadArgs[index])
        && sameRealPath(realpathSync(spec.argv[0]), executable) && fingerprint(spec.argv[0]) === gitReadSha
        && sameRealPath(realpathSync(spec.cwd), expectedCwd);
    } catch { return false; }
  };
}
