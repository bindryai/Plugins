// Pairing login, revoking logout, and the JSON shapes an agent drives them with (BIND-0203).
// Same approach as integration.test.mjs: a real HTTP server standing in for Bindry.API, shaped
// like the real controllers (DeviceAuthorizationController, PersonalApiKeysController), so a drift
// in what we send or expect fails here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_CODE = 'KXMM-TB89';
const DEVICE_CODE = 'device-code-abc';
const API_KEY = 'hbk_issued_by_approval';
const KEY_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '33333333-3333-3333-3333-333333333333';

/**
 * @param script - how the fake API behaves for this test: the sequence of poll outcomes, and
 *   whether revocation succeeds. Recorded calls come back on the returned object.
 */
function startFakeApi(script = {}) {
  const polls = [...(script.polls ?? ['authorization_pending', 'approved'])];
  const calls = { pairingStarts: [], polls: 0, revokes: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = await readBody(req);
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/api/auth/device/code') {
      calls.pairingStarts.push(body?.clientName);
      return json(200, {
        user_code: USER_CODE,
        device_code: DEVICE_CODE,
        verification_uri: 'https://bindry.ai/device',
        verification_uri_complete: `https://bindry.ai/device?code=${USER_CODE}`,
        expires_in: 900,
        // Zero so the tests do not actually wait; the interval handling itself is asserted below.
        interval: 0
      });
    }

    if (url.pathname === '/api/auth/device/token') {
      calls.polls++;
      if (body?.deviceCode !== DEVICE_CODE) return json(400, { error: 'invalid_grant' });
      const next = polls.shift() ?? 'expired_token';
      return next === 'approved'
        ? json(200, { api_key: API_KEY, api_key_id: KEY_ID, tenant_id: TENANT_ID })
        : json(400, { error: next });
    }

    if (url.pathname === '/api/team/my-api-keys/self/revoke') {
      calls.revokes++;
      if (req.headers['x-api-key'] !== API_KEY) return json(401, { error: 'unauthorized' });
      if (script.revokeStatus === 404) return json(404, {});
      if (script.revokeStatus === 500) return json(500, {});
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/api/stacks') {
      if (req.headers['x-api-key'] !== API_KEY && req.headers['x-api-key'] !== 'pasted-token') {
        return json(401, { error: 'unauthorized' });
      }
      return json(200, []);
    }

    return json(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls })));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function withFakeApi(script, fn) {
  const { server, calls } = await startFakeApi(script);
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'bindry-cli-auth-'));
  process.env.BINDRY_CONFIG_DIR = dir;

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  try {
    await fn({ apiBase, calls, logs, configPath: join(dir, 'config.json') });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    delete process.env.BINDRY_CONFIG_DIR;
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}

const readStoredConfig = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

test('login with no token pairs through the browser and stores the key it is handed', async () => {
  await withFakeApi({}, async ({ apiBase, calls, configPath }) => {
    const { login } = await import('./login.mjs');

    await login({ apiBase, noBrowser: true, clientName: 'test-laptop' });

    assert.deepEqual(calls.pairingStarts, ['test-laptop']);
    const stored = readStoredConfig(configPath);
    assert.equal(stored.token, API_KEY);
    assert.equal(stored.apiKeyId, KEY_ID);
    assert.equal(stored.tenantId, TENANT_ID);
  });
});

test('the code and the approval URL are shown before any waiting starts', async () => {
  await withFakeApi({}, async ({ apiBase, logs }) => {
    const { login } = await import('./login.mjs');

    await login({ apiBase, noBrowser: true });

    const output = logs.join('\n');
    assert.match(output, new RegExp(USER_CODE));
    assert.match(output, /bindry\.ai\/device/);
  });
});

test('--json emits the pairing first, so an agent can relay it, then the result', async () => {
  await withFakeApi({}, async ({ apiBase, logs }) => {
    const { login } = await import('./login.mjs');

    await login({ apiBase, noBrowser: true, json: true });

    const events = logs.map((line) => JSON.parse(line));
    assert.equal(events[0].event, 'pairing_started');
    assert.equal(events[0].user_code, USER_CODE);
    // The human-facing instruction is in the payload, so an agent does not have to compose one.
    assert.match(events[0].next_step, new RegExp(USER_CODE));
    assert.equal(events.at(-1).event, 'logged_in');
    assert.equal(events.at(-1).method, 'pairing');
  });
});

test('slow_down widens the interval instead of being treated as a failure', async () => {
  await withFakeApi({ polls: ['slow_down', 'authorization_pending', 'approved'] }, async ({ apiBase, calls, configPath }) => {
    const { login } = await import('./login.mjs');

    await login({ apiBase, noBrowser: true, slowDownStepMs: 1 });

    assert.equal(calls.polls, 3);
    assert.equal(readStoredConfig(configPath).token, API_KEY);
  });
});

test('a refusal in the browser stops the terminal rather than leaving it polling', async () => {
  await withFakeApi({ polls: ['access_denied'] }, async ({ apiBase, configPath }) => {
    const { login } = await import('./login.mjs');

    await assert.rejects(() => login({ apiBase, noBrowser: true }), /refused/);
    assert.equal(readStoredConfig(configPath), null);
  });
});

test('an expired code says to start again, and stores nothing', async () => {
  await withFakeApi({ polls: ['expired_token'] }, async ({ apiBase, configPath }) => {
    const { login } = await import('./login.mjs');

    await assert.rejects(() => login({ apiBase, noBrowser: true }), /expired/);
    assert.equal(readStoredConfig(configPath), null);
  });
});

test('login still accepts a pasted key, because CI has no browser', async () => {
  await withFakeApi({}, async ({ apiBase, calls, configPath }) => {
    const { login } = await import('./login.mjs');

    await login({ token: 'pasted-token', apiBase });

    assert.equal(calls.pairingStarts.length, 0, 'a pasted key must not start a pairing');
    assert.equal(readStoredConfig(configPath).token, 'pasted-token');
  });
});

test('logout revokes the key server-side before forgetting it', async () => {
  await withFakeApi({}, async ({ apiBase, calls, configPath }) => {
    const { login } = await import('./login.mjs');
    const { logout } = await import('./logout.mjs');
    await login({ apiBase, noBrowser: true });

    await logout({ apiBase, token: API_KEY });

    assert.equal(calls.revokes, 1);
    assert.equal(readStoredConfig(configPath), null);
  });
});

test('a failed revoke keeps the token, so the user can still find and revoke it', async () => {
  await withFakeApi({ revokeStatus: 500 }, async ({ apiBase, configPath, logs }) => {
    const { login } = await import('./login.mjs');
    const { logout } = await import('./logout.mjs');
    await login({ apiBase, noBrowser: true });

    await logout({ apiBase, token: API_KEY });

    // Forgetting a key that could not be revoked would leave it live and unnameable.
    assert.equal(readStoredConfig(configPath).token, API_KEY);
    assert.equal(process.exitCode, 1);
    assert.match(logs.join('\n'), /left in place/);
  });
});

test('--keep-key forgets without revoking, for a key shared with CI', async () => {
  await withFakeApi({}, async ({ apiBase, calls, configPath }) => {
    const { login } = await import('./login.mjs');
    const { logout } = await import('./logout.mjs');
    await login({ apiBase, noBrowser: true });

    await logout({ apiBase, token: API_KEY, keepKey: true });

    assert.equal(calls.revokes, 0);
    assert.equal(readStoredConfig(configPath), null);
  });
});

test('whoami answers in JSON, and says plainly when there is no session', async () => {
  await withFakeApi({}, async ({ apiBase, logs }) => {
    const { whoami } = await import('./whoami.mjs');

    await whoami({ apiBase, token: null, json: true });
    assert.equal(JSON.parse(logs.at(-1)).loggedIn, false);
    // Not being logged in is an answer, not a failure.
    assert.notEqual(process.exitCode, 1);

    await whoami({ apiBase, token: API_KEY, json: true });
    const payload = JSON.parse(logs.at(-1));
    assert.equal(payload.loggedIn, true);
    assert.equal(payload.stacks, 0);
  });
});
