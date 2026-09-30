import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All of config.mjs's state lives behind one process-wide env var (BINDRY_CONFIG_DIR), so these
// cases must run one at a time, not node:test's default concurrent scheduling for sibling tests —
// two of them mutating that same env var in parallel is exactly the race this file exists to avoid
// creating. Nesting them as subtests of one parent test gets that sequencing for free.
function withTempConfigDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bindry-cli-test-'));
  const previous = process.env.BINDRY_CONFIG_DIR;
  process.env.BINDRY_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.BINDRY_CONFIG_DIR;
    else process.env.BINDRY_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config.mjs', async (t) => {
  const { writeConfig, readConfig, clearConfig, configPath, resolveSession, DEFAULT_API_BASE } = await import('./config.mjs');

  await t.test('writeConfig then readConfig round-trips, and the file is created', () => {
    withTempConfigDir(() => {
      writeConfig({ apiBase: 'https://api.example.test', token: 'tok_abc' });
      assert.ok(existsSync(configPath()));
      assert.deepEqual(readConfig(), { apiBase: 'https://api.example.test', token: 'tok_abc' });
    });
  });

  await t.test('readConfig returns {} when no file exists yet', () => {
    withTempConfigDir(() => {
      assert.deepEqual(readConfig(), {});
    });
  });

  await t.test('clearConfig removes the file without throwing if it never existed', () => {
    withTempConfigDir(() => {
      assert.doesNotThrow(() => clearConfig());
      assert.equal(existsSync(configPath()), false);
    });
  });

  await t.test('resolveSession prefers an explicit argument, then env vars, then the saved config', () => {
    withTempConfigDir(() => {
      // Nothing set anywhere: falls back to the public default.
      assert.deepEqual(resolveSession(), { apiBase: DEFAULT_API_BASE, token: null });

      // Saved config wins over the default.
      writeConfig({ apiBase: 'https://saved.test', token: 'saved-token' });
      assert.deepEqual(resolveSession(), { apiBase: 'https://saved.test', token: 'saved-token' });

      // Env vars win over saved config.
      process.env.BINDRY_API_BASE = 'https://env.test';
      process.env.BINDRY_API_TOKEN = 'env-token';
      try {
        assert.deepEqual(resolveSession(), { apiBase: 'https://env.test', token: 'env-token' });
        // An explicit argument wins over everything.
        assert.deepEqual(resolveSession({ apiBase: 'https://flag.test', token: 'flag-token' }), {
          apiBase: 'https://flag.test',
          token: 'flag-token'
        });
      } finally {
        delete process.env.BINDRY_API_BASE;
        delete process.env.BINDRY_API_TOKEN;
      }
    });
  });
});
