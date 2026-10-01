// The rules-folder format, and the publish command that reads it (BIND-0197).
//
// Built against real files on disk and a real in-process HTTP server, because the two things most likely
// to be wrong are "did we read the folder the way a repo actually lays it out" and "did we send a shape
// the API accepts" — and a stub of our own reader would confirm neither.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSourceFolder,
  writeSourceFolder,
  binderDocumentFrom,
  skillDocumentFrom,
  textFrom,
  linesFor
} from './format.mjs';
import { tidyRemote } from './gitref.mjs';

const TOKEN = 'test-token';

/** A full Skill as the workspace API returns it — every field an author owns, plus server-side state. */
function apiSkill(slug, instructions) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    slug,
    title: 'Service layer auditing',
    summary: 'Audit at the service layer.',
    category: 'architecture',
    visibility: 'Public',
    status: 'Published',
    currentVersion: '2.1.0',
    audience: ['backend'],
    tags: ['ibeam', 'audit'],
    scope: { appliesWhen: ['Writing a service operation'], doesNotApplyWhen: ['In a repository'] },
    instructions,
    constraints: ['Never log PHI'],
    examples: [{ input: 'A create', outputExpectation: 'An audit row' }],
    verificationChecklist: ['An audit row exists'],
    supportedTargets: ['Claude', 'Codex'],
    tokenEstimate: { estimated: 40, alwaysLoaded: 0, taskLoaded: 40 },
    trust: { reviewed: false, riskLevel: 'Low', provenance: '', labels: [] }
  };
}

function makeFolder({ instructions = 'Audit every service operation.' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bindry-source-'));
  const dir = join(root, '.bindry');
  mkdirSync(join(dir, 'skills'), { recursive: true });

  writeFileSync(join(dir, 'binder.json'), JSON.stringify({
    slug: 'ibeam-architecture',
    title: 'IBeam Architecture',
    summary: 'How IBeam services are built.',
    category: 'architecture',
    visibility: 'Public',
    audience: [],
    tags: ['ibeam'],
    supportedTargets: ['Claude', 'Codex'],
    tokenEstimate: { estimated: 80 },
    trust: {}
  }, null, 2), 'utf8');

  writeFileSync(join(dir, 'skills', 'service-layer-auditing.json'), JSON.stringify({
    slug: 'service-layer-auditing',
    title: 'Service layer auditing',
    summary: 'Audit at the service layer.',
    category: 'architecture',
    visibility: 'Public',
    scope: { appliesWhen: ['Writing a service operation'], doesNotApplyWhen: [] },
    instructions,
    constraints: [],
    examples: [],
    verificationChecklist: [],
    supportedTargets: ['Claude'],
    tokenEstimate: { estimated: 40 },
    trust: {}
  }, null, 2), 'utf8');

  return { root, dir };
}

function withFolder(fn, options) {
  const made = makeFolder(options);
  return Promise.resolve(fn(made)).finally(() => rmSync(made.root, { recursive: true, force: true }));
}

function startFakeApi({ status = 200, body } = {}) {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;

    const json = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url === '/api/binders/from-source' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== TOKEN) return json(401, { error: 'unauthorized' });
      const payload = JSON.parse(raw);
      received.push(payload);
      if (status !== 200) return json(status, body);
      return json(200, body ?? {
        binderId: '33333333-3333-3333-3333-333333333333',
        binderSlug: payload.binder.slug,
        binderAction: 'created',
        publishedVersion: payload.publish ? payload.binderVersion : '',
        skills: payload.skills.map((document) => ({
          slug: document.skill.slug,
          path: document.path,
          skillId: '11111111-1111-1111-1111-111111111111',
          action: 'created',
          version: '1.0.0',
          message: ''
        })),
        removed: []
      });
    }

    return json(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received })));
}

async function withApi(options, fn) {
  const { server, received } = await startFakeApi(options);
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await fn({ apiBase, received, logs });
  } finally {
    console.log = originalLog;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a rules folder reads back as the Binder plus its Skills, in filename order', async () => {
  await withFolder(({ dir }) => {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'a-first-rule.json'), JSON.stringify({ slug: 'a-first-rule', title: 'First', instructions: 'Do this.' }), 'utf8');

    const folder = readSourceFolder(dir);

    assert.equal(folder.binder.slug, 'ibeam-architecture');
    assert.deepEqual(folder.skills.map((item) => item.skill.slug), ['a-first-rule', 'service-layer-auditing']);
    // The path is recorded per document so the app can point a reader at the real file.
    assert.equal(folder.skills[1].path, '.bindry/skills/service-layer-auditing.json');
    assert.deepEqual(folder.problems, []);
  });
});

test('instructions may be an array of lines, so a prose diff is reviewable', async () => {
  await withFolder(({ dir }) => {
    writeFileSync(join(dir, 'skills', 'multi.json'), JSON.stringify({
      slug: 'multi',
      title: 'Multi',
      instructions: ['First line.', '', 'Second line.']
    }), 'utf8');

    const folder = readSourceFolder(dir);
    const multi = folder.skills.find((item) => item.skill.slug === 'multi');

    assert.equal(multi.skill.instructions, 'First line.\n\nSecond line.');
  });
});

test('one unreadable file is reported rather than sinking the whole folder', async () => {
  await withFolder(({ dir }) => {
    writeFileSync(join(dir, 'skills', 'broken.json'), '{ not json', 'utf8');

    const folder = readSourceFolder(dir);

    assert.equal(folder.skills.length, 1, 'the good file still read');
    assert.equal(folder.problems.length, 1);
    assert.match(folder.problems[0].reason, /not valid JSON/);
  });
});

test('a folder with no binder.json says what is missing instead of publishing nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bindry-source-empty-'));
  try {
    assert.throws(() => readSourceFolder(root), /needs one/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Binder and its Skills round-trip through the folder without loss', async () => {
  // The claim this format has to earn: eject then publish must send the API exactly what it had. Written
  // against the full workspace shapes, not the public export, which carries only what a consumer compiles.
  const root = mkdtempSync(join(tmpdir(), 'bindry-roundtrip-'));
  try {
    const binder = {
      id: '44444444-4444-4444-4444-444444444444',
      slug: 'ibeam-architecture',
      title: 'IBeam Architecture',
      summary: 'How IBeam services are built.',
      category: 'architecture',
      visibility: 'Public',
      status: 'Published',
      currentVersion: '2.0.0',
      audience: ['backend'],
      tags: ['ibeam'],
      supportedTargets: ['Claude', 'Codex'],
      tokenEstimate: { estimated: 80, alwaysLoaded: 0, taskLoaded: 80 },
      trust: { reviewed: false, riskLevel: 'Low', provenance: '', labels: [] }
    };
    const skill = apiSkill('service-layer-auditing', 'Audit every service operation.\n\nEven the reads.');

    const binderDocument = binderDocumentFrom(binder);
    const skillDocument = skillDocumentFrom(skill);
    writeSourceFolder(join(root, '.bindry'), { binder: binderDocument, skills: [skillDocument] });

    const folder = readSourceFolder(join(root, '.bindry'));

    assert.deepEqual(folder.binder, binderDocument);
    assert.deepEqual(folder.skills[0].skill, skillDocument);
    // Including the newlines inside the prose, which is the part the lines representation touches.
    assert.equal(folder.skills[0].skill.instructions, 'Audit every service operation.\n\nEven the reads.');

    // And server-side state is deliberately not in the folder: a repo does not get to assert its own
    // review status, token estimate, or published version.
    const onDisk = JSON.parse(readFileSync(join(root, '.bindry', 'skills', 'service-layer-auditing.json'), 'utf8'));
    assert.equal(onDisk.status, undefined);
    assert.equal(onDisk.currentVersion, undefined);
    assert.equal(onDisk.id, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writing a folder clears Skills that are no longer in the Binder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bindry-stale-'));
  try {
    const dir = join(root, '.bindry');
    writeSourceFolder(dir, { binder: { slug: 's' }, skills: [{ slug: 'kept', instructions: 'a' }, { slug: 'dropped', instructions: 'b' }] });
    assert.ok(existsSync(join(dir, 'skills', 'dropped.json')));

    writeSourceFolder(dir, { binder: { slug: 's' }, skills: [{ slug: 'kept', instructions: 'a' }] });

    // A stale file left behind would be read by the next publish as a rule that still exists.
    assert.ok(!existsSync(join(dir, 'skills', 'dropped.json')));
    assert.ok(existsSync(join(dir, 'skills', 'kept.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publish sends the folder whole, with the repository and commit it came from', async () => {
  await withApi({}, async ({ apiBase, received }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api', revision: 'abc1234', json: true });

      const payload = received[0];
      assert.equal(payload.sourceRef.repository, 'github.com/acme/api');
      assert.equal(payload.sourceRef.revision, 'abc1234');
      assert.equal(payload.binder.slug, 'ibeam-architecture');
      assert.equal(payload.skills.length, 1);
      assert.equal(payload.skills[0].skill.instructions, 'Audit every service operation.');
      // Staged unless asked otherwise.
      assert.equal(payload.publish, false);
    });
  });
});

test('--take-ownership is the only thing that asks to take over app-authored content', async () => {
  await withApi({}, async ({ apiBase, received }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api', json: true });
      await publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api', takeOwnership: true, json: true });

      // Never sent as true unless asked: taking over content someone authored in the app is not reversible
      // by re-running, so it must not be something a default turns on.
      assert.equal(received[0].adoptExisting, false);
      assert.equal(received[1].adoptExisting, true);
    });
  });
});

test('publish --publish requires a version rather than guessing one', async () => {
  await withApi({}, async ({ apiBase, received }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await assert.rejects(
        () => publish({ apiBase, token: TOKEN, dir, publish: true, repository: 'github.com/acme/api' }),
        /--binder-version/
      );
      assert.equal(received.length, 0, 'nothing was sent');
    });
  });
});

test('publish --dry-run sends nothing and needs no key', async () => {
  await withApi({}, async ({ apiBase, received, logs }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await publish({ apiBase, token: null, dir, dryRun: true, repository: 'github.com/acme/api', json: true });

      assert.equal(received.length, 0);
      const payload = JSON.parse(logs.at(-1));
      assert.equal(payload.event, 'publish_preview');
      assert.equal(payload.payload.skills.length, 1);
    });
  });
});

test('publishing for real without a key refuses instead of silently doing nothing', async () => {
  await withApi({}, async ({ apiBase }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await assert.rejects(
        () => publish({ apiBase, token: null, dir, repository: 'github.com/acme/api' }),
        /not logged in/
      );
    });
  });
});

test('a failed document makes the command exit non-zero, so CI notices', async () => {
  const body = {
    binderId: '33333333-3333-3333-3333-333333333333',
    binderSlug: 'ibeam-architecture',
    binderAction: 'updated',
    publishedVersion: '',
    skills: [{ slug: 'service-layer-auditing', path: '.bindry/skills/service-layer-auditing.json', skillId: '1', action: 'failed', version: '', message: 'Instructions are required.' }],
    removed: []
  };
  await withApi({ body }, async ({ apiBase, logs }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');
      const before = process.exitCode;

      await publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api' });

      assert.equal(process.exitCode, 1);
      assert.ok(logs.some((line) => line.includes('Instructions are required.')));
      assert.ok(logs.some((line) => line.includes('not published')));
      process.exitCode = before;
    });
  });
});

test('a rejected push surfaces the API field error, not just the status code', async () => {
  const body = { title: 'One or more validation errors occurred.', errors: { Binder: ['The Binder needs a slug.'] } };
  await withApi({ status: 400, body }, async ({ apiBase }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await assert.rejects(
        () => publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api' }),
        /The Binder needs a slug/
      );
    });
  });
});

test('publish refuses when it cannot tell which repository this is', async () => {
  await withApi({}, async ({ apiBase }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      // An empty string, not undefined: undefined would fall back to git detection, and the test machine
      // is itself inside a repo, so the fallback would succeed and the assertion would prove nothing.
      await assert.rejects(
        () => publish({ apiBase, token: TOKEN, dir, repository: '' }),
        /which repository/
      );
    });
  });
});

test('git remotes in every shape read as one host/owner/name', () => {
  assert.equal(tidyRemote('git@github.com:acme/api.git'), 'github.com/acme/api');
  assert.equal(tidyRemote('https://github.com/acme/api.git'), 'github.com/acme/api');
  assert.equal(tidyRemote('https://github.com/acme/api'), 'github.com/acme/api');
  assert.equal(tidyRemote(null), '');
});

test('the lines convention is only used where it helps', () => {
  assert.equal(linesFor('one line'), 'one line');
  assert.deepEqual(linesFor('two\nlines'), ['two', 'lines']);
  assert.equal(textFrom(['two', 'lines']), 'two\nlines');
  assert.equal(textFrom(undefined), '');
});

// F1 decision 1 accepted a hard break on one explicit condition: failures must name the upgrade
// rather than being cryptic. A rules folder is written by the developer, not by Bindry, so someone
// who wrote forty rule files and upgraded the CLI must not be told their folder is missing a file
// they never knew existed.
test('a rules folder written by 0.1.x says so, instead of reporting a missing binder.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'bindry-legacy-'));
  const dir = join(root, '.bindry');
  mkdirSync(join(dir, 'bindings'), { recursive: true });
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({ slug: 'ibeam-architecture' }), 'utf8');
  writeFileSync(join(dir, 'bindings', 'service-layer-auditing.json'), JSON.stringify({ slug: 'service-layer-auditing' }), 'utf8');

  try {
    assert.throws(
      () => readSourceFolder(dir),
      (err) => {
        // The two things the message has to carry: that 0.2.0 is the cause, and what to do about it.
        assert.match(err.message, /0\.2\.0/);
        assert.match(err.message, /stack\.json/);
        assert.match(err.message, /binder\.json/);
        assert.match(err.message, /bindings\//);
        assert.match(err.message, /skills\//);
        // And what it must NOT be: the bare "no binder.json" that sent 0.1.x users looking for a
        // file they never wrote.
        assert.ok(!/^no binder\.json/.test(err.message), 'must not lead with the bare missing-file error');
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty folder still gets the plain missing-file error, not the upgrade message', () => {
  // The legacy path must not swallow the ordinary case — someone running publish in the wrong
  // directory should be told a rules folder needs a binder.json, not that they need to upgrade.
  const root = mkdtempSync(join(tmpdir(), 'bindry-empty-'));
  const dir = join(root, '.bindry');
  mkdirSync(dir, { recursive: true });

  try {
    assert.throws(() => readSourceFolder(dir), /no binder\.json/);
    assert.throws(() => readSourceFolder(dir), (err) => !/0\.2\.0/.test(err.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
