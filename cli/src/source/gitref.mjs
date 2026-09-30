// Which repository and commit a publish is coming from (BIND-0197).
//
// Read from the local checkout, never from github.com: the job doing the publish is already sitting in the
// repo. In GitHub Actions the environment already says both, and those are preferred — a shallow checkout
// or a detached HEAD can make `git` disagree with what the workflow actually ran on.
//
// Overlaps deliberately with BIND-0205's import/provenance.mjs, which does the same remote tidying for a
// different command. Whichever branch lands first, the other should collapse into it.

import { execFileSync } from 'node:child_process';

export function detectSourceRef(cwd) {
  return {
    repository: fromEnvRepository() || tidyRemote(git(cwd, ['config', '--get', 'remote.origin.url'])) || '',
    revision: process.env.GITHUB_SHA || git(cwd, ['rev-parse', 'HEAD']) || ''
  };
}

/** GITHUB_REPOSITORY is "owner/name"; the server wants a host-qualified name. */
function fromEnvRepository() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) return '';
  const host = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `${host}/${repository}`;
}

/** git@github.com:acme/api.git and https://github.com/acme/api.git both read as github.com/acme/api. */
export function tidyRemote(remote) {
  if (!remote) return '';
  return remote
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^ssh:\/\/git@/, '')
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
