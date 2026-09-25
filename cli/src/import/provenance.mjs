// Where an imported Binding came from (BIND-0205). Useful even though nothing is being
// redistributed: six months later, "which file was this, in which repo, at which commit" is the
// question someone actually asks.

import { execFileSync } from 'node:child_process';

/**
 * "github.com/acme/api@a1b2c3d" when the directory is a git repo, otherwise null. Best effort:
 * git may be absent, the directory may not be a repo, and neither is a reason to fail an import.
 */
export function describeGitSource(root) {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  const commit = git(root, ['rev-parse', '--short', 'HEAD']);

  if (!remote && !commit) return null;
  if (!remote) return commit;

  return commit ? `${tidyRemote(remote)}@${commit}` : tidyRemote(remote);
}

/** git@github.com:acme/api.git and https://github.com/acme/api.git both read as github.com/acme/api. */
function tidyRemote(remote) {
  return remote
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '');
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
