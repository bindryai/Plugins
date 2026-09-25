// Importing the instruction files a project already has (BIND-0205). Built against a real
// directory tree on disk and a real in-process API, because the two things most likely to be wrong
// are "did we find the file" and "did we send a shape the API accepts" — neither of which a stub
// of our own parser would catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForInstructionFiles } from './scan.mjs';
import { toBindingDraft, splitFrontmatter, slugify } from './parse.mjs';

const TOKEN = 'test-token';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'bindry-import-'));

  write(root, '.claude/skills/branch-hygiene/SKILL.md', [
    '---',
    'name: branch-hygiene',
    'description: Branch & PR hygiene. Use when opening a pull request.',
    '---',
    '',
    'Scope every commit to one concern.'
  ]);

  // Runnable tooling beside the markdown: read the instructions, ignore the executables.
  write(root, '.claude/skills/branch-hygiene/scripts/check.sh', ['#!/bin/sh', 'echo nope']);
  write(root, '.claude/skills/branch-hygiene/references/notes.md', ['Background reading.']);

  write(root, '.cursor/rules/testing.mdc', [
    '---',
    'description: How we test',
    'globs: src/**/*.ts, tests/**/*.ts',
    'alwaysApply: false',
    '---',
    '',
    'Write the failing test first.'
  ]);

  write(root, '.windsurf/rules/style.md', [
    '---',
    'trigger: always_on',
    'description: House style',
    '---',
    '',
    'Prefer clarity over cleverness.'
  ]);

  write(root, '.github/instructions/api.instructions.md', [
    '---',
    'applyTo: "src/api/**"',
    'description: API conventions',
    '---',
    '',
    'Endpoints stay thin.'
  ]);

  // Prose, not one rule per file — reported, never silently imported as a single giant Binding.
  write(root, 'AGENTS.md', ['# Agents', '', 'Lots of prose about many different rules at once.']);
  write(root, '.github/copilot-instructions.md', ['Repo-wide prose instructions.']);

  // Nothing usable: frontmatter but no body.
  write(root, '.agents/skills/empty-rule/SKILL.md', ['---', 'name: empty-rule', 'description: Nothing here.', '---', '']);

  return root;
}

function write(root, relativePath, lines) {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

function startFakeApi({ rejectSlug } = {}) {
  const created = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/api/bindings' && req.method === 'POST') {
      if (req.headers['x-api-key'] !== TOKEN) return json(401, { error: 'unauthorized' });
      const body = JSON.parse(raw);
      if (body.slug === rejectSlug) return json(400, { title: 'That slug is taken' });
      created.push(body);
      return json(201, { id: `id-${created.length}`, ...body });
    }

    return json(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, created })));
}

async function withApi(options, fn) {
  const { server, created } = await startFakeApi(options);
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await fn({ apiBase, created, logs });
  } finally {
    console.log = originalLog;
    await new Promise((resolve) => server.close(resolve));
  }
}

function withProject(fn) {
  const root = makeProject();
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('every supported format is found, and tooling beside the markdown is not', async () => {
  await withProject((root) => {
    const found = scanForInstructionFiles(root).map((f) => f.relativePath);

    assert.ok(found.includes('.claude/skills/branch-hygiene/SKILL.md'));
    assert.ok(found.includes('.cursor/rules/testing.mdc'));
    assert.ok(found.includes('.windsurf/rules/style.md'));
    assert.ok(found.includes('.github/instructions/api.instructions.md'));
    assert.ok(found.includes('AGENTS.md'));
    assert.ok(found.includes('.github/copilot-instructions.md'));

    // We import instructions, not executables — and not the reference material beside them.
    assert.ok(!found.some((f) => f.includes('scripts/')), 'scripts must not be imported');
    assert.ok(!found.some((f) => f.includes('references/')), 'references must not be imported');
  });
});

test('a SKILL.md becomes a Binding without any guessing', async () => {
  await withProject((root) => {
    const source = scanForInstructionFiles(root).find((f) => f.relativePath.endsWith('branch-hygiene/SKILL.md'));

    const draft = toBindingDraft(source, { provenance: 'github.com/acme/api@abc1234' });

    assert.equal(draft.slug, 'branch-hygiene');
    assert.equal(draft.title, 'Branch Hygiene');
    assert.equal(draft.instructions, 'Scope every commit to one concern.');
    assert.deepEqual(draft.appliesWhen, ['Branch & PR hygiene. Use when opening a pull request.']);
    assert.equal(draft.provenance, 'github.com/acme/api@abc1234 — .claude/skills/branch-hygiene/SKILL.md');
  });
});

test('a glob is recorded as where, not pretended to be when', async () => {
  await withProject((root) => {
    const cursor = scanForInstructionFiles(root).find((f) => f.relativePath.endsWith('testing.mdc'));

    const draft = toBindingDraft(cursor);

    // "src/**/*.ts" says where a rule applies, not the moment it should fire. Recorded literally so
    // the information survives and a human can see it needs rewriting into a real trigger.
    assert.deepEqual(draft.appliesWhen, [
      'Working in files matching src/**/*.ts',
      'Working in files matching tests/**/*.ts'
    ]);
    assert.equal(draft.summary, 'How we test');
  });
});

test('a file with frontmatter but no body produces nothing rather than an empty Binding', async () => {
  await withProject((root) => {
    const empty = scanForInstructionFiles(root).find((f) => f.relativePath.includes('empty-rule'));

    assert.equal(toBindingDraft(empty), null);
  });
});

test('import creates private drafts and never publishes', async () => {
  await withApi({}, async ({ apiBase, created }) => {
    await withProject(async (root) => {
      const { importRules } = await import('../commands/import.mjs');

      await importRules({ apiBase, token: TOKEN, path: root, json: true });

      assert.equal(created.length, 4, 'the four structured files');
      for (const binding of created) {
        assert.equal(binding.visibility, 'Private');
        assert.equal(binding.trust.reviewed, false);
        assert.ok(binding.trust.labels.includes('Imported'));
        assert.ok(binding.trust.provenance.length > 0, 'every Binding records where it came from');
      }
    });
  });
});

test('prose is reported for review instead of being imported as one giant rule', async () => {
  await withApi({}, async ({ apiBase, created, logs }) => {
    await withProject(async (root) => {
      const { importRules } = await import('../commands/import.mjs');

      await importRules({ apiBase, token: TOKEN, path: root, json: true });

      const payload = JSON.parse(logs.at(-1));
      const agents = payload.results.find((r) => r.file === 'AGENTS.md');
      assert.equal(agents.status, 'needs-review');
      assert.ok(!created.some((b) => b.slug === 'agents'), 'AGENTS.md must not become a Binding here');
    });
  });
});

test('one rejected Binding does not sink the rest of the import', async () => {
  await withApi({ rejectSlug: 'branch-hygiene' }, async ({ apiBase, created, logs }) => {
    await withProject(async (root) => {
      const { importRules } = await import('../commands/import.mjs');

      await importRules({ apiBase, token: TOKEN, path: root, json: true });

      const payload = JSON.parse(logs.at(-1));
      const failed = payload.results.filter((r) => r.status === 'failed');
      assert.equal(failed.length, 1);
      assert.match(failed[0].reason, /taken|400/);
      assert.equal(created.length, 3, 'the others still went in');
    });
  });
});

test('--dry-run writes nothing anywhere, and works without logging in', async () => {
  await withApi({}, async ({ apiBase, created, logs }) => {
    await withProject(async (root) => {
      const { importRules } = await import('../commands/import.mjs');

      await importRules({ apiBase, token: null, path: root, dryRun: true, json: true });

      assert.equal(created.length, 0);
      const payload = JSON.parse(logs.at(-1));
      assert.equal(payload.event, 'import_preview');
      assert.equal(payload.results.filter((r) => r.status === 'would-create').length, 4);
    });
  });
});

test('importing for real without a token refuses rather than silently doing nothing', async () => {
  await withApi({}, async ({ apiBase }) => {
    await withProject(async (root) => {
      const { importRules } = await import('../commands/import.mjs');

      await assert.rejects(() => importRules({ apiBase, token: null, path: root }), /not logged in/);
    });
  });
});

test('a directory with nothing in it says so instead of looking broken', async () => {
  await withApi({}, async ({ apiBase, logs }) => {
    const empty = mkdtempSync(join(tmpdir(), 'bindry-import-empty-'));
    try {
      const { importRules } = await import('../commands/import.mjs');

      await importRules({ apiBase, token: TOKEN, path: empty, json: true });

      assert.deepEqual(JSON.parse(logs.at(-1)).results, []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

test('frontmatter parsing handles quotes and missing blocks', () => {
  assert.deepEqual(splitFrontmatter('no frontmatter here').data, {});
  assert.equal(splitFrontmatter('---\nname: "quoted"\n---\nbody').data.name, 'quoted');
  assert.equal(splitFrontmatter('---\nname: bare\n---\nbody').body, 'body');
  assert.equal(slugify('Branch & PR Hygiene'), 'branch-pr-hygiene');
});
