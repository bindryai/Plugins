// End-to-end tests against a tiny in-process HTTP server standing in for Bindry.API. There's no
// access to a real running Bindry.API in this environment, so this is the closest thing to a real
// round trip: real HTTP, real JSON parsing, real fetch — only the server on the other end is fake,
// and it's shaped exactly like the real controllers (Bindry.API/Controllers/{Stacks,PublicCatalog}
// Controller.cs) so a shape drift here would also break against the real API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token';
const STACK_ID = '11111111-1111-1111-1111-111111111111';
const BINDING_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BINDING_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SKILL_BUNDLE = {
  slug: 'git-flow',
  title: 'Git Flow',
  tokenEstimate: 42,
  bindings: [
    { id: BINDING_A, slug: 'branch-naming', title: 'Branch naming', version: '3', instructions: 'Name branches feature/<ticket>.' },
    { id: BINDING_B, slug: 'commit-style', title: 'Commit style', version: '1', instructions: 'Use conventional commits.' }
  ]
};

function startFakeApi() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers['x-api-key'];
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/stacks' && req.method === 'GET') {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, [{ id: STACK_ID, slug: 'git-flow', title: 'Git Flow', status: 'Published', currentVersion: '2' }]);
    }
    if (url.pathname === `/api/stacks/${STACK_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, { stackTitle: 'Git Flow', target: 'SkillBundle', fileName: 'git-flow.json', content: JSON.stringify(SKILL_BUNDLE) });
    }
    if (url.pathname === `/api/stacks/${STACK_ID}`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        stack: { id: STACK_ID, slug: 'git-flow', title: 'Git Flow', currentVersion: '2', summary: 'How we branch.' },
        // Current pinned version for branch-naming has moved to "4" server-side, ahead of the "3"
        // baked into SKILL_BUNDLE above — this is the drift `bindry check` should report as stale.
        bindings: [
          { bindingId: BINDING_A, bindingSlug: 'branch-naming', bindingTitle: 'Branch naming', pinnedVersion: '4' },
          { bindingId: BINDING_B, bindingSlug: 'commit-style', bindingTitle: 'Commit style', pinnedVersion: '1' }
        ]
      });
    }
    if (url.pathname === '/api/public/catalog/stacks/git-flow') {
      return json(200, {
        listing: { sourceId: STACK_ID, slug: 'git-flow', title: 'Git Flow', currentVersion: '2', summary: 'Public copy.' },
        bindings: [
          { bindingId: BINDING_A, bindingSlug: 'branch-naming', bindingTitle: 'Branch naming', pinnedVersion: '4' },
          { bindingId: BINDING_B, bindingSlug: 'commit-style', bindingTitle: 'Commit style', pinnedVersion: '1' }
        ]
      });
    }
    if (url.pathname === '/api/public/catalog/stacks/git-flow/export') {
      return json(200, { stackTitle: 'Git Flow', target: url.searchParams.get('target'), fileName: 'git-flow.json', content: JSON.stringify(SKILL_BUNDLE) });
    }
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withFakeApi(fn) {
  const server = await startFakeApi();
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(apiBase);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bindry-cli-out-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('login succeeds with a valid token and fails with a bad one', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (configDir) => {
      process.env.BINDRY_CONFIG_DIR = configDir;
      try {
        const { login } = await import('./commands/login.mjs');
        await assert.doesNotReject(() => login({ token: TOKEN, apiBase }));
        await assert.rejects(() => login({ token: 'wrong-token', apiBase }), /could not verify/);
      } finally {
        delete process.env.BINDRY_CONFIG_DIR;
      }
    });
  });
});

test('list rejects with no token, and returns the workspace\'s Stacks with one', async () => {
  await withFakeApi(async (apiBase) => {
    const { list } = await import('./commands/list.mjs');
    await assert.rejects(() => list({ apiBase, token: null }), /not logged in/);

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      await list({ apiBase, token: TOKEN, json: true });
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(logs.join('\n'));
    assert.equal(parsed[0].slug, 'git-flow');
  });
});

test('show finds a Stack by slug in the public Library with no token', async () => {
  await withFakeApi(async (apiBase) => {
    const { show } = await import('./commands/show.mjs');
    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      await show({ apiBase, token: null, id: 'git-flow' });
    } finally {
      console.log = original;
    }
    assert.ok(logs.some((line) => line.includes('Git Flow')));
    assert.ok(logs.some((line) => line.includes('(public)')));
  });
});

test('pull writes one SKILL.md per Binding with a parseable pin comment', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({ apiBase, token: TOKEN, id: STACK_ID, out: outDir, target: 'skill-bundle', mode: 'pinned' });

      const skillPath = join(outDir, 'branch-naming', 'SKILL.md');
      assert.ok(existsSync(skillPath));
      const contents = readFileSync(skillPath, 'utf8');
      assert.ok(contents.includes('Name branches feature/<ticket>.'));
      // The pin records STACK_ID (what was actually passed to `pull`), not the compiled content's
      // "git-flow" slug — see pull.mjs's pinStackRef comment for why that distinction matters for
      // a private-only Stack.
      assert.match(contents, new RegExp(`bindry:pin stack=${STACK_ID} binding=${BINDING_A} version=3`));
    });
  });
});

test('check reports a pulled Binding as stale once the server-side pin has moved on', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      // Pulled at version 3 (baked into SKILL_BUNDLE); the fake API's /api/stacks/{id} above
      // reports the Stack's current pin for the same Binding as version 4.
      await pull({ apiBase, token: TOKEN, id: STACK_ID, out: join(bindryDir, 'git-flow'), target: 'skill-bundle' });

      const rows = [];
      const original = console.log;
      console.log = (msg) => rows.push(msg);
      try {
        await check({ apiBase, token: TOKEN, dir: bindryDir, json: true });
      } finally {
        console.log = original;
      }
      const parsed = JSON.parse(rows.join('\n'));
      const staleRow = parsed.find((r) => r.skillDir === 'branch-naming');
      assert.equal(staleRow.status, 'stale');
      assert.equal(staleRow.currentVersion, '4');
      const upToDateRow = parsed.find((r) => r.skillDir === 'commit-style');
      assert.equal(upToDateRow.status, 'up to date');
    });
  });
});
