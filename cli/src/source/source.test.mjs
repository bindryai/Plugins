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
  stackDocumentFrom,
  bindingDocumentFrom,
  textFrom,
  linesFor
} from './format.mjs';
import { tidyRemote } from './gitref.mjs';

const TOKEN = 'test-token';

/** A full Binding as the workspace API returns it — every field an author owns, plus server-side state. */
function apiBinding(slug, instructions) {
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
  mkdirSync(join(dir, 'bindings'), { recursive: true });

  writeFileSync(join(dir, 'stack.json'), JSON.stringify({
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

  writeFileSync(join(dir, 'bindings', 'service-layer-auditing.json'), JSON.stringify({
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

    if (req.url === '/api/stacks/from-source' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== TOKEN) return json(401, { error: 'unauthorized' });
      const payload = JSON.parse(raw);
      received.push(payload);
      if (status !== 200) return json(status, body);
      return json(200, body ?? {
        stackId: '33333333-3333-3333-3333-333333333333',
        stackSlug: payload.stack.slug,
        stackAction: 'created',
        publishedVersion: payload.publish ? payload.stackVersion : '',
        bindings: payload.bindings.map((document) => ({
          slug: document.binding.slug,
          path: document.path,
          bindingId: '11111111-1111-1111-1111-111111111111',
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

test('a rules folder reads back as the Stack plus its Bindings, in filename order', async () => {
  await withFolder(({ dir }) => {
    mkdirSync(join(dir, 'bindings'), { recursive: true });
    writeFileSync(join(dir, 'bindings', 'a-first-rule.json'), JSON.stringify({ slug: 'a-first-rule', title: 'First', instructions: 'Do this.' }), 'utf8');

    const folder = readSourceFolder(dir);

    assert.equal(folder.stack.slug, 'ibeam-architecture');
    assert.deepEqual(folder.bindings.map((item) => item.binding.slug), ['a-first-rule', 'service-layer-auditing']);
    // The path is recorded per document so the app can point a reader at the real file.
    assert.equal(folder.bindings[1].path, '.bindry/bindings/service-layer-auditing.json');
    assert.deepEqual(folder.problems, []);
  });
});

test('instructions may be an array of lines, so a prose diff is reviewable', async () => {
  await withFolder(({ dir }) => {
    writeFileSync(join(dir, 'bindings', 'multi.json'), JSON.stringify({
      slug: 'multi',
      title: 'Multi',
      instructions: ['First line.', '', 'Second line.']
    }), 'utf8');

    const folder = readSourceFolder(dir);
    const multi = folder.bindings.find((item) => item.binding.slug === 'multi');

    assert.equal(multi.binding.instructions, 'First line.\n\nSecond line.');
  });
});

test('one unreadable file is reported rather than sinking the whole folder', async () => {
  await withFolder(({ dir }) => {
    writeFileSync(join(dir, 'bindings', 'broken.json'), '{ not json', 'utf8');

    const folder = readSourceFolder(dir);

    assert.equal(folder.bindings.length, 1, 'the good file still read');
    assert.equal(folder.problems.length, 1);
    assert.match(folder.problems[0].reason, /not valid JSON/);
  });
});

test('a folder with no stack.json says what is missing instead of publishing nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bindry-source-empty-'));
  try {
    assert.throws(() => readSourceFolder(root), /needs one/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Stack and its Bindings round-trip through the folder without loss', async () => {
  // The claim this format has to earn: eject then publish must send the API exactly what it had. Written
  // against the full workspace shapes, not the public export, which carries only what a consumer compiles.
  const root = mkdtempSync(join(tmpdir(), 'bindry-roundtrip-'));
  try {
    const stack = {
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
    const binding = apiBinding('service-layer-auditing', 'Audit every service operation.\n\nEven the reads.');

    const stackDocument = stackDocumentFrom(stack);
    const bindingDocument = bindingDocumentFrom(binding);
    writeSourceFolder(join(root, '.bindry'), { stack: stackDocument, bindings: [bindingDocument] });

    const folder = readSourceFolder(join(root, '.bindry'));

    assert.deepEqual(folder.stack, stackDocument);
    assert.deepEqual(folder.bindings[0].binding, bindingDocument);
    // Including the newlines inside the prose, which is the part the lines representation touches.
    assert.equal(folder.bindings[0].binding.instructions, 'Audit every service operation.\n\nEven the reads.');

    // And server-side state is deliberately not in the folder: a repo does not get to assert its own
    // review status, token estimate, or published version.
    const onDisk = JSON.parse(readFileSync(join(root, '.bindry', 'bindings', 'service-layer-auditing.json'), 'utf8'));
    assert.equal(onDisk.status, undefined);
    assert.equal(onDisk.currentVersion, undefined);
    assert.equal(onDisk.id, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writing a folder clears Bindings that are no longer in the Stack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bindry-stale-'));
  try {
    const dir = join(root, '.bindry');
    writeSourceFolder(dir, { stack: { slug: 's' }, bindings: [{ slug: 'kept', instructions: 'a' }, { slug: 'dropped', instructions: 'b' }] });
    assert.ok(existsSync(join(dir, 'bindings', 'dropped.json')));

    writeSourceFolder(dir, { stack: { slug: 's' }, bindings: [{ slug: 'kept', instructions: 'a' }] });

    // A stale file left behind would be read by the next publish as a rule that still exists.
    assert.ok(!existsSync(join(dir, 'bindings', 'dropped.json')));
    assert.ok(existsSync(join(dir, 'bindings', 'kept.json')));
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
      assert.equal(payload.stack.slug, 'ibeam-architecture');
      assert.equal(payload.bindings.length, 1);
      assert.equal(payload.bindings[0].binding.instructions, 'Audit every service operation.');
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
        /--stack-version/
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
      assert.equal(payload.payload.bindings.length, 1);
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
    stackId: '33333333-3333-3333-3333-333333333333',
    stackSlug: 'ibeam-architecture',
    stackAction: 'updated',
    publishedVersion: '',
    bindings: [{ slug: 'service-layer-auditing', path: '.bindry/bindings/service-layer-auditing.json', bindingId: '1', action: 'failed', version: '', message: 'Instructions are required.' }],
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
  const body = { title: 'One or more validation errors occurred.', errors: { Stack: ['The Stack needs a slug.'] } };
  await withApi({ status: 400, body }, async ({ apiBase }) => {
    await withFolder(async ({ dir }) => {
      const { publish } = await import('../commands/publish.mjs');

      await assert.rejects(
        () => publish({ apiBase, token: TOKEN, dir, repository: 'github.com/acme/api' }),
        /The Stack needs a slug/
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
