// Spawns the real CLI as a subprocess for the cases that are actually about the process boundary —
// argv parsing and exit codes — rather than importing main() directly, which would need it guarded
// against running on import the way the plugins' own compile-stack.mjs guards itself. This is also
// exactly the layer that had two real bugs during development (--help/--version being swallowed as
// "flag expects a value", and --version never being reached because the no-command branch ran
// first) — a unit test on parseArgs alone would not have caught either, since both were about how
// main() used the parsed flags, not the parsing itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('./bindry.mjs', import.meta.url));

async function run(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await run('--help');
  assert.equal(code, 0);
  assert.match(stdout, /Usage: bindry <command>/);
});

test('--version prints just the version and exits 0 (not the help text)', async () => {
  const { code, stdout } = await run('--version');
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('no arguments at all prints usage and exits 1', async () => {
  const { code, stdout } = await run();
  assert.equal(code, 1);
  assert.match(stdout, /Usage: bindry <command>/);
});

test('an unknown command exits 1 with a pointer to --help', async () => {
  const { code, stderr } = await run('frobnicate');
  assert.equal(code, 1);
  assert.match(stderr, /unknown command "frobnicate"/);
});

test('show with no identifier fails with a usage message before making any request', async () => {
  const { code, stderr } = await run('show');
  assert.equal(code, 1);
  assert.match(stderr, /usage: bindry show <slug-or-id>/);
});

test('a flag placed before the command is still parsed (--json search)', async () => {
  // Not a claim that this ever reaches the network: --api-base points nowhere, so it fails fast on
  // a connection error — the point is only that --json survived being placed before the command.
  const { stderr } = await run('--api-base', 'http://127.0.0.1:1', 'search', '--json', 'anything');
  assert.match(stderr, /could not reach/);
});
