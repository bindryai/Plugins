// End-to-end tests against a tiny in-process HTTP server standing in for Bindry.API. There's no
// access to a real running Bindry.API in this environment, so this is the closest thing to a real
// round trip: real HTTP, real JSON parsing, real fetch — only the server on the other end is fake,
// and it's shaped exactly like the real controllers (Bindry.API/Controllers/{Binders,PublicCatalog}
// Controller.cs) so a shape drift here would also break against the real API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOKEN = 'test-token';
const BINDER_ID = '11111111-1111-1111-1111-111111111111';
const SKILL_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SKILL_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
// A Skill pulled entirely on its own (BIND-0190) — never part of a Binder. Published at version 2,
// but the compiled content below is still the "1" snapshot, the same staleness setup the Binder test
// uses for SKILL_A.
const SKILL_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STANDALONE_SKILL = {
  id: SKILL_C,
  slug: 'quick-review',
  title: 'Quick Review',
  version: '1',
  instructions: 'Look for the obvious stuff first: does it build, does it have tests, is the diff small.'
};

const SKILL_BUNDLE = {
  slug: 'git-flow',
  title: 'Git Flow',
  tokenEstimate: 42,
  skills: [
    { id: SKILL_A, slug: 'branch-naming', title: 'Branch naming', version: '3', instructions: 'Name branches feature/<ticket>.' },
    { id: SKILL_B, slug: 'commit-style', title: 'Commit style', version: '1', instructions: 'Use conventional commits.' }
  ]
};

// What version 1 of the Binder recorded: one skill, at the version it was pinned to then. The
// current composition above has two skills and has moved branch-naming on — so pulling v1 and
// pulling current must give visibly different files.
const SKILL_BUNDLE_V1 = {
  slug: 'git-flow',
  title: 'Git Flow',
  tokenEstimate: 20,
  skills: [
    { id: SKILL_A, slug: 'branch-naming', title: 'Branch naming', version: '1', instructions: 'Name branches by ticket.' }
  ]
};

// BIND-0262: a Copilot Binder whose every skill is path-shaped. On Copilot such a skill renders to
// a .github/instructions file INSTEAD OF a SKILL.md, so the export carries an EMPTY skills array
// and all of its content in instructions[]. The plugin compilers now accept this; THIS CLI does not
// write path-matched instruction files at all, so it must refuse — but refuse by saying what is
// actually wrong, rather than blaming the export for "missing a non-empty skills array".
const INSTRUCTIONS_ONLY_BINDER_ID = '22222222-2222-2222-2222-222222222222';
const INSTRUCTIONS_ONLY_BUNDLE = {
  slug: 'file-shaped-conventions',
  title: 'File-Shaped Conventions',
  tokenEstimate: 90,
  skills: [],
  instructions: [
    {
      path: '.github/instructions/typescript-conventions.instructions.md',
      content: '---\napplyTo: "**/*.ts"\n---\n\nPrefer const over let.\n'
    }
  ]
};

// BIND-0265. A Binder with BOTH kinds of output — the common real case, and the one that used to fail
// silently: the SKILL.md landed and the path-scoped rule vanished with no warning.
const MIXED_BINDER_ID = '33333333-3333-3333-3333-333333333333';
const MIXED_BUNDLE = {
  slug: 'mixed-conventions',
  title: 'Mixed Conventions',
  tokenEstimate: 120,
  skills: [
    { id: SKILL_A, slug: 'branch-naming', title: 'Branch naming', version: '3', instructions: 'Name branches feature/<ticket>.' }
  ],
  instructions: [
    {
      path: '.github/instructions/typescript-conventions.instructions.md',
      content: '---\napplyTo: "**/*.ts"\n---\n\nPrefer const over let.\n'
    }
  ]
};

// An instruction path that climbs out of the directory `bindry pull` was run in. The server builds
// these paths itself today, so this should be unreachable in practice — which is why it is worth a
// test rather than trust.
const ESCAPING_BINDER_ID = '44444444-4444-4444-4444-444444444444';
const ESCAPING_BUNDLE = {
  slug: 'escaping-conventions',
  title: 'Escaping Conventions',
  skills: [],
  instructions: [
    // Climbs exactly ONE level. The test runs from a subdirectory of its own temp dir, so if the
    // guard ever regresses the stray file lands inside that temp dir and is cleaned up with it.
    // An earlier version used "../../" and wrote into %LOCALAPPDATA% during a mutation run — which
    // then made the test fail on its next real run, because the leftover was still there.
    { path: '../escaped.instructions.md', content: 'should never be written\n' }
  ]
};

// An export with nothing at all to write. Its own test is what stops the widened guard from
// accepting an empty Binder as well as an instructions-only one.
const EMPTY_BINDER_ID = '55555555-5555-5555-5555-555555555555';
const EMPTY_BUNDLE = { slug: 'empty-binder', title: 'Empty Binder', skills: [], instructions: [] };

// BIND-0176: the public read path is rate limited. These two stand in for a limiter that sends a
// Retry-After and one that does not, because the CLI has to be useful either way.
const RATE_LIMITED_BINDER_ID = '66666666-6666-6666-6666-666666666666';
const RATE_LIMITED_NO_HEADER_BINDER_ID = '77777777-7777-7777-7777-777777777777';

function startFakeApi() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers['x-api-key'];
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/binders' && req.method === 'GET') {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, [{ id: BINDER_ID, slug: 'git-flow', title: 'Git Flow', status: 'Published', currentVersion: '2' }]);
    }
    if (url.pathname === `/api/binders/${BINDER_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      // Mirrors BindersController.Export's version handling (BIND-0252): a known version serves that
      // version's compilation, an unknown one is a 400 naming the ones that exist, and omitting it
      // serves the current composition with no version on the response.
      const requested = url.searchParams.get('version');
      if (requested) {
        if (requested !== '1') {
          return json(400, {
            title: 'One or more validation errors occurred.',
            errors: { Version: [`Version '${requested}' is not published for this Binder. Published versions: 1.`] }
          });
        }
        return json(200, {
          binderTitle: 'Git Flow',
          target: url.searchParams.get('target'),
          version: '1',
          currentVersion: '2',
          fileName: 'git-flow.json',
          content: JSON.stringify(SKILL_BUNDLE_V1)
        });
      }
      return json(200, { binderTitle: 'Git Flow', target: 'SkillBundle', fileName: 'git-flow.json', content: JSON.stringify(SKILL_BUNDLE) });
    }
    if (url.pathname === `/api/binders/${INSTRUCTIONS_ONLY_BINDER_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        binderTitle: 'File-Shaped Conventions',
        target: 'SkillBundle',
        fileName: 'file-shaped-conventions.json',
        content: JSON.stringify(INSTRUCTIONS_ONLY_BUNDLE)
      });
    }
    if (url.pathname === `/api/binders/${MIXED_BINDER_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        binderTitle: 'Mixed Conventions',
        target: 'SkillBundle',
        fileName: 'mixed-conventions.json',
        content: JSON.stringify(MIXED_BUNDLE)
      });
    }
    if (url.pathname === `/api/binders/${EMPTY_BINDER_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        binderTitle: 'Empty Binder',
        target: 'SkillBundle',
        fileName: 'empty-binder.json',
        content: JSON.stringify(EMPTY_BUNDLE)
      });
    }
    if (url.pathname === `/api/binders/${ESCAPING_BINDER_ID}/export`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        binderTitle: 'Escaping Conventions',
        target: 'SkillBundle',
        fileName: 'escaping-conventions.json',
        content: JSON.stringify(ESCAPING_BUNDLE)
      });
    }
    // Shaped like the real limiter's rejection: ProblemDetails plus Retry-After in seconds.
    if (url.pathname === `/api/binders/${RATE_LIMITED_BINDER_ID}/export`) {
      res.writeHead(429, { 'content-type': 'application/problem+json', 'retry-after': '7' });
      return res.end(JSON.stringify({
        status: 429,
        title: 'Too many requests',
        detail: 'This endpoint allows 30 requests every 10 seconds per IP address. Retry in 7 second(s).'
      }));
    }
    // A limiter, proxy or CDN that rejects without the header. The CLI still has to say something
    // useful, so this is not a hypothetical worth skipping.
    if (url.pathname === `/api/binders/${RATE_LIMITED_NO_HEADER_BINDER_ID}/export`) {
      res.writeHead(429, { 'content-length': '0' });
      return res.end();
    }
    if (url.pathname === `/api/binders/${BINDER_ID}`) {
      if (auth !== TOKEN) return json(401, { error: 'unauthorized' });
      return json(200, {
        binder: { id: BINDER_ID, slug: 'git-flow', title: 'Git Flow', currentVersion: '2', summary: 'How we branch.' },
        // Current pinned version for branch-naming has moved to "4" server-side, ahead of the "3"
        // baked into SKILL_BUNDLE above — this is the drift `bindry check` should report as stale.
        skills: [
          { skillId: SKILL_A, skillSlug: 'branch-naming', skillTitle: 'Branch naming', pinnedVersion: '4' },
          { skillId: SKILL_B, skillSlug: 'commit-style', skillTitle: 'Commit style', pinnedVersion: '1' }
        ]
      });
    }
    if (url.pathname === '/api/public/catalog/binders/git-flow') {
      return json(200, {
        listing: { sourceId: BINDER_ID, slug: 'git-flow', title: 'Git Flow', currentVersion: '2', summary: 'Public copy.' },
        skills: [
          { skillId: SKILL_A, skillSlug: 'branch-naming', skillTitle: 'Branch naming', pinnedVersion: '4' },
          { skillId: SKILL_B, skillSlug: 'commit-style', skillTitle: 'Commit style', pinnedVersion: '1' }
        ]
      });
    }
    if (url.pathname === '/api/public/catalog/binders/git-flow/export') {
      return json(200, { binderTitle: 'Git Flow', target: url.searchParams.get('target'), fileName: 'git-flow.json', content: JSON.stringify(SKILL_BUNDLE) });
    }
    // The real endpoint resolves "by slug or id" (PublicCatalogController.GetSkill) — mirrored here
    // so a pin recorded by GUID (the common case for check, since pull.mjs records the identifier it
    // was actually given) resolves the same way a slug does.
    if (url.pathname === '/api/public/catalog/skills/quick-review' || url.pathname === `/api/public/catalog/skills/${SKILL_C}`) {
      return json(200, { listing: { sourceId: SKILL_C, slug: 'quick-review', title: 'Quick Review', currentVersion: '2', summary: 'Fast first-pass review.' } });
    }
    if (url.pathname === '/api/public/catalog/skills/quick-review/export') {
      return json(200, { skillTitle: 'Quick Review', target: url.searchParams.get('target'), fileName: 'quick-review.json', content: JSON.stringify(STANDALONE_SKILL) });
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

// Path-matched instruction files land relative to process.cwd(), not --out, because Copilot decides
// where they live. So a test that pulls one has to OWN the working directory — otherwise it writes
// .github/instructions/ into this package and leaves it there.
function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bindry-cli-cwd-'));
  const before = process.cwd();
  process.chdir(dir);
  return Promise.resolve(fn(dir)).finally(() => {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  });
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

test('list rejects with no token, and returns the workspace\'s Binders with one', async () => {
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

test('show finds a Binder by slug in the public Library with no token', async () => {
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

test('pull writes one SKILL.md per Skill with a parseable pin comment', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({ apiBase, token: TOKEN, id: BINDER_ID, out: outDir, target: 'skill-bundle', mode: 'pinned' });

      const skillPath = join(outDir, 'branch-naming', 'SKILL.md');
      assert.ok(existsSync(skillPath));
      const contents = readFileSync(skillPath, 'utf8');
      assert.ok(contents.includes('Name branches feature/<ticket>.'));
      // The pin records BINDER_ID (what was actually passed to `pull`), not the compiled content's
      // "git-flow" slug — see pull.mjs's pinBinderRef comment for why that distinction matters for
      // a private-only Binder.
      assert.match(contents, new RegExp(`bindry:pin binder=${BINDER_ID} skill=${SKILL_A} version=3`));
    });
  });
});

// --- Pulling a specific Binder version (BIND-0252) ---

test('pull --binder-version installs that version, not the current composition', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({ apiBase, token: TOKEN, id: BINDER_ID, out: outDir, target: 'skill-bundle', binderVersion: '1' });

      const pinned = join(outDir, 'branch-naming', 'SKILL.md');
      assert.ok(existsSync(pinned));
      const contents = readFileSync(pinned, 'utf8');
      // v1's recorded content and version, not the current composition's.
      assert.ok(contents.includes('Name branches by ticket.'));
      assert.ok(!contents.includes('Name branches feature/<ticket>.'));
      assert.match(contents, new RegExp(`skill=${SKILL_A} version=1 binder-version=1`));
      // The second skill only exists in the current composition, so pinning to v1 must not write it.
      assert.ok(!existsSync(join(outDir, 'commit-style', 'SKILL.md')));
    });
  });
});

test('pull without --binder-version records no binder-version, so existing pins keep their meaning', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({ apiBase, token: TOKEN, id: BINDER_ID, out: outDir, target: 'skill-bundle' });

      const contents = readFileSync(join(outDir, 'branch-naming', 'SKILL.md'), 'utf8');
      assert.ok(!contents.includes('binder-version='), 'an unpinned pull must not claim a Binder version');
    });
  });
});

test('pull --binder-version at a version that does not exist lists the ones that do', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      // The API answers 400 with a field error; the point is that the user sees the real versions
      // rather than "request failed", and that nothing is written.
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: BINDER_ID, out: outDir, target: 'skill-bundle', binderVersion: '9.9.9' }),
        /Published versions: 1/
      );
      assert.ok(!existsSync(join(outDir, 'branch-naming', 'SKILL.md')));
    });
  });
});

// BIND-0265. The CLI now writes Copilot's path-matched instruction files. Before this, it had no
// code for them at all: a mixed Binder's SKILL.md landed and its path-scoped rule vanished with no
// warning, and the pull reported success. BIND-0262's interim refusal is gone with the gap it
// described.
test('pull writes the path-matched instruction files a Binder carries', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (cwd) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({
        apiBase, token: TOKEN, id: INSTRUCTIONS_ONLY_BINDER_ID,
        out: join(cwd, 'out'), target: 'skill-bundle', mode: 'pinned'
      });

      // Relative to the repo root, NOT to --out, because Copilot decides where these live.
      const written = join(cwd, '.github', 'instructions', 'typescript-conventions.instructions.md');
      assert.ok(existsSync(written), 'no instruction file was written');
      assert.match(readFileSync(written, 'utf8'), /^---\napplyTo: "\*\*\/\*\.ts"\n---/);
    });
  });
});

test('pull writes BOTH kinds of output for a mixed Copilot Binder', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (cwd) => {
      const { pull } = await import('./commands/pull.mjs');
      const outDir = join(cwd, 'out');
      await pull({ apiBase, token: TOKEN, id: MIXED_BINDER_ID, out: outDir, target: 'skill-bundle', mode: 'pinned' });

      // This is the case that used to half-work, and the half that went missing is the second one.
      assert.ok(existsSync(join(outDir, 'branch-naming', 'SKILL.md')), 'the SKILL.md is missing');
      assert.ok(
        existsSync(join(cwd, '.github', 'instructions', 'typescript-conventions.instructions.md')),
        'the path-matched instruction file is missing — this is the BIND-0265 regression'
      );
    });
  });
});

test('pull still refuses an export with neither Skills nor instruction files, and says what was missing', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (cwd) => {
      const { pull } = await import('./commands/pull.mjs');
      // Without this, widening the guard to accept instructions-only would also accept nothing at all.
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: EMPTY_BINDER_ID, out: join(cwd, 'out'), target: 'skill-bundle', mode: 'pinned' }),
        /no Skills and no instruction files/
      );
    });
  });
});

test('pull refuses an instruction path that climbs out of the working directory', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (root) => {
      // Run from a subdirectory, so the path the Binder asks for ("../escaped.instructions.md")
      // escapes into `root` — which this helper deletes — rather than into a real user directory.
      const work = join(root, 'work');
      mkdirSync(work, { recursive: true });
      process.chdir(work);

      const { pull } = await import('./commands/pull.mjs');
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: ESCAPING_BINDER_ID, out: join(work, 'out'), target: 'skill-bundle', mode: 'pinned' }),
        /outside this directory/
      );
      // The refusal has to mean nothing was written, not that it was written and then complained about.
      assert.ok(!existsSync(resolve(root, 'escaped.instructions.md')), 'the escaping file was written anyway');
    });
  });
});

// BIND-0176. A single `bindry pull` is ONE request against a 30-per-10-seconds limit, so nobody
// reaches this by installing one Binder — it is reachable by a loop, a CI fleet, or several
// developers behind one egress IP. In all three cases the only useful thing to say is how long to
// wait, and before this the CLI said "request failed: 429 Too Many Requests".
test('pull tells you how long to wait when the public read path rate-limits it', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (cwd) => {
      const { pull } = await import('./commands/pull.mjs');
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: RATE_LIMITED_BINDER_ID, out: join(cwd, 'out'), target: 'skill-bundle', mode: 'pinned' }),
        (err) => {
          assert.match(err.message, /too many requests \(429\)/i);
          assert.match(err.message, /Wait 7 second\(s\)/);
          // The limiter's own sentence is worth passing through — it states the actual budget.
          assert.match(err.message, /30 requests every 10 seconds/);
          assert.equal(err.status, 429);
          return true;
        }
      );
    });
  });
});

test('pull still says something useful when a 429 carries no Retry-After', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempCwd(async (cwd) => {
      const { pull } = await import('./commands/pull.mjs');
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: RATE_LIMITED_NO_HEADER_BINDER_ID, out: join(cwd, 'out'), target: 'skill-bundle', mode: 'pinned' }),
        (err) => {
          assert.match(err.message, /too many requests \(429\)/i);
          assert.match(err.message, /Wait a few seconds/);
          assert.equal(err.status, 429);
          return true;
        }
      );
    });
  });
});

test('pull refuses --binder-version together with --mode live', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await assert.rejects(
        () => pull({ apiBase, token: TOKEN, id: BINDER_ID, out: outDir, mode: 'live', binderVersion: '1' }),
        /cannot be combined with --mode live/
      );
    });
  });
});

test('pull --binder-version does not silently fall back to a standalone Skill', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      // "quick-review" resolves as a Skill, which has no Binder versions — honouring the flag by
      // ignoring it would hand back files that are not the version that was asked for.
      await assert.rejects(
        () => pull({ apiBase, token: null, id: 'quick-review', out: outDir, binderVersion: '1' }),
        /--binder-version only applies to a Binder/
      );
    });
  });
});

test('pull falls back to a standalone Skill (BIND-0190) when no Binder matches, with no binder= in the pin', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (outDir) => {
      const { pull } = await import('./commands/pull.mjs');
      await pull({ apiBase, token: null, id: 'quick-review', out: outDir, target: 'skill-bundle' });

      const skillPath = join(outDir, 'quick-review', 'SKILL.md');
      assert.ok(existsSync(skillPath));
      const contents = readFileSync(skillPath, 'utf8');
      assert.ok(contents.includes(STANDALONE_SKILL.instructions));
      assert.match(contents, new RegExp(`bindry:pin skill=${SKILL_C} version=1`));
      assert.ok(!contents.includes('binder='), 'a standalone pull must not fabricate a binder= field');
    });
  });
});

test('check resolves a standalone Skill pin by its own id and reports drift, not "no longer part of this Binder"', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      // Pulled at version 1 (STANDALONE_SKILL); the fake API's public detail route above reports
      // this Skill's current version as 2.
      await pull({ apiBase, token: null, id: 'quick-review', out: bindryDir, target: 'skill-bundle' });

      const rows = [];
      const original = console.log;
      console.log = (msg) => rows.push(msg);
      try {
        await check({ apiBase, token: null, dir: bindryDir, json: true });
      } finally {
        console.log = original;
      }
      const parsed = JSON.parse(rows.join('\n'));
      const row = parsed.find((r) => r.skillDir === 'quick-review');
      assert.equal(row.binder, null);
      assert.equal(row.status, 'stale');
      assert.equal(row.currentVersion, '2');
    });
  });
});

// --- check respects a deliberate Binder-version pin (BIND-0257) ---
//
// Before this, check compared every pin against the Binder's CURRENT composition. Someone who pulled
// v1 on purpose was told their skills were stale and then told to "run bindry pull again" — which
// drops the --binder-version and moves them to current. The tool was telling them to abandon the
// pin. The advice was the bug, not the label.

test('check measures a version-pinned install against what that version locked, not current', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      // v1 locks branch-naming at "1". The Binder's current composition has moved it to "4" and
      // added a second skill — so comparing against current would call this stale.
      await pull({
        apiBase, token: TOKEN, id: BINDER_ID,
        out: join(bindryDir, 'git-flow'), target: 'skill-bundle', binderVersion: '1'
      });

      const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir });

      const row = parsed.find((r) => r.skillDir === 'branch-naming');
      assert.equal(row.status, 'up to date');
      assert.equal(row.binderVersion, '1');
      // Carried on the row so a CI job sees it without parsing console text, and without the
      // --json shape changing.
      assert.equal(row.binderLatest, '2');
      assert.notEqual(process.exitCode, 1);
    });
  });
});

test('check reports a newer Binder version as information, never as staleness', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      await pull({
        apiBase, token: TOKEN, id: BINDER_ID,
        out: join(bindryDir, 'git-flow'), target: 'skill-bundle', binderVersion: '1'
      });

      const logs = [];
      const original = console.log;
      console.log = (msg) => logs.push(String(msg));
      try {
        await check({ apiBase, token: TOKEN, dir: bindryDir });
      } finally {
        console.log = original;
      }
      const output = logs.join('\n');

      assert.match(output, /pinned at v1; v2 has since been published/);
      // The locking rule, said to the person it affects.
      assert.match(output, /Nothing changes until you choose it/);
      // And the two things that must NOT appear: the old verdict and the advice that undoes the pin.
      assert.ok(!/are stale/.test(output), 'a deliberately pinned install is not stale');
      assert.ok(!/Run "bindry pull git-flow" again/.test(output), 'must not advise dropping the pin');
    });
  });
});

test('check tells a genuinely altered pinned install to restore its own version, not current', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      await pull({
        apiBase, token: TOKEN, id: BINDER_ID,
        out: join(bindryDir, 'git-flow'), target: 'skill-bundle', binderVersion: '1'
      });

      // Simulate a local edit: the file now claims a skill version v1 never locked.
      const skillPath = join(bindryDir, 'git-flow', 'branch-naming', 'SKILL.md');
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('version=1 ', 'version=7 '), 'utf8');

      const logs = [];
      const original = console.log;
      console.log = (msg) => logs.push(String(msg));
      try {
        await check({ apiBase, token: TOKEN, dir: bindryDir });
      } finally {
        console.log = original;
      }
      const output = logs.join('\n');

      // Stale is correct here — but the remedy must restore v1, not move to current.
      assert.match(output, /do not match what they were pulled at/);
      assert.match(output, /--binder-version 1/);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    });
  });
});

test('check on a pinned version that no longer exists says so, and does not advise re-pulling', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      await pull({
        apiBase, token: TOKEN, id: BINDER_ID,
        out: join(bindryDir, 'git-flow'), target: 'skill-bundle', binderVersion: '1'
      });

      // Rewrite the pin to a Binder version the API does not have — what a recall looks like from
      // the consumer's side (BIND-0209).
      const skillPath = join(bindryDir, 'git-flow', 'branch-naming', 'SKILL.md');
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('binder-version=1', 'binder-version=9.9.9'), 'utf8');

      const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir });

      const row = parsed.find((r) => r.skillDir === 'branch-naming');
      assert.equal(row.status, 'unknown');
      // The API's own words, so the real versions are visible rather than "request failed".
      assert.match(row.note, /Published versions: 1/);
      process.exitCode = 0;
    });
  });
});

async function runCheckJson(check, options) {
  const logs = [];
  const original = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    await check({ ...options, json: true });
  } finally {
    console.log = original;
  }
  return JSON.parse(logs.join('\n'));
}

test('check reports a pulled Skill as stale once the server-side pin has moved on', async () => {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      const { pull } = await import('./commands/pull.mjs');
      const { check } = await import('./commands/check.mjs');

      // Pulled at version 3 (baked into SKILL_BUNDLE); the fake API's /api/binders/{id} above
      // reports the Binder's current pin for the same Skill as version 4.
      await pull({ apiBase, token: TOKEN, id: BINDER_ID, out: join(bindryDir, 'git-flow'), target: 'skill-bundle' });

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

// --- check reads Copilot's path-matched instruction files (BIND-0267) ---
//
// pull writes a path-shaped skill to .github/instructions/<slug>.instructions.md at the repo root
// INSTEAD OF a SKILL.md. check scanned --dir for SKILL.md only, so those files were never looked at:
// pull one, let the Binder move on, and nothing said so. The marker they carry records the SKILL, not
// the Binder, so they are matched to Binders this run resolved from SKILL.md pins.

const instructionFile = (skill, version) =>
  `---\napplyTo: "**/*.ts"\n---\n\n<!-- bindry:instructions skill=${skill} version=${version} -->\n\nPrefer const over let.\n`;

function writeInstructionFile(root, name, skill, version) {
  const path = join(root, '.github', 'instructions', `${name}.instructions.md`);
  mkdirSync(join(root, '.github', 'instructions'), { recursive: true });
  writeFileSync(path, instructionFile(skill, version), 'utf8');
}

async function withPulledBinder(options, run) {
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      await withTempDir(async (root) => {
        const { pull } = await import('./commands/pull.mjs');
        const { check } = await import('./commands/check.mjs');
        await pull({
          apiBase, token: TOKEN, id: BINDER_ID,
          out: join(bindryDir, 'git-flow'), target: 'skill-bundle', ...options
        });
        try {
          await run({ apiBase, bindryDir, root, check });
        } finally {
          process.exitCode = 0;
        }
      });
    });
  });
}

test('check reports an instruction file for a skill the Binder has moved on as stale', async () => {
  await withPulledBinder({}, async ({ apiBase, bindryDir, root, check }) => {
    // The fake API's current pin for SKILL_A is 4; this file was pulled at 3.
    writeInstructionFile(root, 'branch-naming', SKILL_A, '3');

    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    const row = parsed.find((r) => r.kind === 'instructions');
    assert.equal(row.file, '.github/instructions/branch-naming.instructions.md');
    assert.equal(row.status, 'stale');
    assert.equal(row.currentVersion, '4');
    // The Binder is named as the pin named it: pulled by id, so the pin carries the id.
    assert.equal(row.binder, BINDER_ID);
    // --json never set an exit code for stale SKILL.md rows either; the machine reads the status.
  });
});

test('check reports an instruction file at the Binder\'s current version as up to date', async () => {
  await withPulledBinder({}, async ({ apiBase, bindryDir, root, check }) => {
    writeInstructionFile(root, 'branch-naming', SKILL_A, '4');

    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    assert.equal(parsed.find((r) => r.kind === 'instructions').status, 'up to date');
    assert.notEqual(process.exitCode, 1);
  });
});

test('check measures an instruction file against the Binder version it was pulled at, not current', async () => {
  // v1 of the Binder locks SKILL_A at 1; the Binder now pins it at 4. Holding 1 is exactly what a
  // pinned install asked for. Comparing against current would tell them to abandon the pin (BIND-0257).
  await withPulledBinder({ binderVersion: '1' }, async ({ apiBase, bindryDir, root, check }) => {
    writeInstructionFile(root, 'branch-naming', SKILL_A, '1');

    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    const row = parsed.find((r) => r.kind === 'instructions');
    assert.equal(row.status, 'up to date');
    assert.equal(row.binderVersion, '1');
    assert.notEqual(process.exitCode, 1);
  });
});

test('check leaves an instruction file unchecked when no pulled Binder contains its skill', async () => {
  await withPulledBinder({}, async ({ apiBase, bindryDir, root, check }) => {
    writeInstructionFile(root, 'elsewhere', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '1');

    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    const row = parsed.find((r) => r.kind === 'instructions');
    assert.equal(row.status, 'unchecked');
    assert.match(row.note, /not in any Binder pulled here/);
    // Unchecked is not stale: nothing is known to be wrong, so nothing fails a CI job.
    assert.notEqual(process.exitCode, 1);
  });
});

test('check does not dismiss a repo of only instruction files as having no skills', async () => {
  // A Binder made entirely of path-shaped skills pulls to no SKILL.md at all.
  await withFakeApi(async (apiBase) => {
    await withTempDir(async (bindryDir) => {
      await withTempDir(async (root) => {
        const { check } = await import('./commands/check.mjs');
        writeInstructionFile(root, 'typescript-conventions', SKILL_A, '3');

        const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].kind, 'instructions');
        assert.equal(parsed[0].status, 'unchecked');
        assert.match(parsed[0].note, /no pulled Binder to compare it with/);
      });
    });
  });
});

test('check ignores a hand-written instruction file with no Bindry marker', async () => {
  await withPulledBinder({}, async ({ apiBase, bindryDir, root, check }) => {
    mkdirSync(join(root, '.github', 'instructions'), { recursive: true });
    writeFileSync(join(root, '.github', 'instructions', 'mine.instructions.md'), '---\napplyTo: "**"\n---\n\nUse tabs.\n', 'utf8');

    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    assert.equal(parsed.filter((r) => r.kind === 'instructions').length, 0);
  });
});

test('check output for a repo with no instruction files is exactly what it was', async () => {
  await withPulledBinder({}, async ({ apiBase, bindryDir, root, check }) => {
    const parsed = await runCheckJson(check, { apiBase, token: TOKEN, dir: bindryDir, root });

    assert.ok(parsed.length > 0);
    assert.ok(parsed.every((r) => r.kind === undefined), 'SKILL.md rows must keep their existing shape');

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(String(msg));
    try {
      await check({ apiBase, token: TOKEN, dir: bindryDir, root });
    } finally {
      console.log = original;
    }
    assert.doesNotMatch(logs.join('\n'), /Path-matched instruction files/);
  });
});

test('check tells the reader a stale file for a skill that left path-matching is theirs to delete', async () => {
  // Pulled at Binder v1 so every SKILL.md is exactly what v1 locked: the only thing that can fail the
  // run here is the instruction file, which keeps the exit-code assertion below honest.
  await withPulledBinder({ binderVersion: '1' }, async ({ apiBase, bindryDir, root, check }) => {
    writeInstructionFile(root, 'branch-naming', SKILL_A, '0');

    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(String(msg));
    try {
      await check({ apiBase, token: TOKEN, dir: bindryDir, root });
    } finally {
      console.log = original;
    }
    const output = logs.join('\n');

    assert.match(output, /Path-matched instruction files/);
    assert.match(output, /1 instruction file\(s\) do not match what they were pulled at\./);
    // Held to the version it was pulled at, and told to restore THAT version, not to move to current.
    assert.ok(output.includes(`.github/instructions/branch-naming.instructions.md: run "bindry pull ${BINDER_ID} --binder-version 1" to refresh it.`));
    // A pull writes files and never removes one, so re-pulling cannot clear a leftover.
    assert.match(output, /no longer matched by path leaves its old file behind; delete that one\./);
    // Stale means a CI job should notice, as it does for a stale SKILL.md.
    assert.equal(process.exitCode, 1);
  });
});
