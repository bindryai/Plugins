import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readInstructionFiles, judgeInstructionFile } from './check-drift.mjs';

// --- BIND-0267: drift checking for path-shaped skills -------------------------------------------
//
// On Copilot a skill with appliesToPaths compiles to .github/instructions/<slug>.instructions.md
// INSTEAD OF a SKILL.md. Every drift scan looked for <dir>/<subdir>/SKILL.md, so these files were never
// looked at: pull one, let the Binder move on, and nothing said so.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-drift.mjs');

const TS_SKILL = '11111111-1111-4111-8111-111111111111';
const SQL_SKILL = '22222222-2222-4222-8222-222222222222';
const OTHER_SKILL = '33333333-3333-4333-8333-333333333333';

const instructionFile = (skill, version, body = 'Prefer readonly.') =>
  `---\napplyTo: "**/*.ts"\n---\n\n<!-- bindry:instructions skill=${skill} version=${version} -->\n\n${body}\n`;

const skillMd = (skill, version) =>
  `---\nname: x\n---\n<!-- bindry:pin binder=house skill=${skill} version=${version} -->\n\nDo the thing.\n`;

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'bindry-instr-'));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
}

// --- reading -------------------------------------------------------------------------------------

test('finds the instruction files Bindry wrote, with the skill and version each one carries', () => {
  const root = repoWith({
    '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.0.0'),
    '.github/instructions/sql.instructions.md': instructionFile(SQL_SKILL, '2.3.0')
  });

  const files = readInstructionFiles(root);

  assert.deepEqual(files, [
    { file: '.github/instructions/sql.instructions.md', skill: SQL_SKILL, version: '2.3.0' },
    { file: '.github/instructions/typescript.instructions.md', skill: TS_SKILL, version: '1.0.0' }
  ]);
});

test('ignores a hand-written instruction file, which carries no Bindry marker', () => {
  // Copilot users write their own. Reporting on them would be reporting on files that are not ours.
  const root = repoWith({
    '.github/instructions/mine.instructions.md': '---\napplyTo: "**"\n---\n\nUse tabs.\n'
  });

  assert.deepEqual(readInstructionFiles(root), []);
});

test('ignores a marker in a file that is not an instructions file', () => {
  const root = repoWith({
    '.github/instructions/notes.md': instructionFile(TS_SKILL, '1.0.0'),
    '.github/instructions/skip/typescript.instructions.md': instructionFile(TS_SKILL, '1.0.0')
  });

  assert.deepEqual(readInstructionFiles(root), []);
});

test('says nothing for a repo with no instruction files', () => {
  assert.deepEqual(readInstructionFiles(repoWith({ 'README.md': '# hi\n' })), []);
});

// --- judging -------------------------------------------------------------------------------------

test('a file at the version the Binder pins is current', () => {
  const verdict = judgeInstructionFile({ skill: TS_SKILL, version: '1.0.0' }, new Map([[TS_SKILL, '1.0.0']]));

  assert.deepEqual(verdict, { status: 'current', expected: '1.0.0' });
});

test('a file behind what the Binder pins is stale, and says what it should be', () => {
  const verdict = judgeInstructionFile({ skill: TS_SKILL, version: '1.0.0' }, new Map([[TS_SKILL, '1.4.0']]));

  assert.deepEqual(verdict, { status: 'stale', expected: '1.4.0' });
});

test('a skill that is not in this Binder is elsewhere, not wrong', () => {
  // The marker carries no Binder slug, so this may be a perfectly healthy second Binder's file.
  const verdict = judgeInstructionFile({ skill: OTHER_SKILL, version: '1.0.0' }, new Map([[TS_SKILL, '1.0.0']]));

  assert.deepEqual(verdict, { status: 'elsewhere', expected: null });
});

// --- the whole run, against a fake API -----------------------------------------------------------

/** Serves the Library export the drift check reads, listing the given skills at the given versions. */
async function withFakeApi({ skills, currentVersion = '2.0.0', pinnedVersion = null }, run) {
  const server = createServer((request, response) => {
    if (!request.url.startsWith('/api/public/catalog/binders/house/export')) {
      response.writeHead(404).end();
      return;
    }
    const content = JSON.stringify({
      slug: 'house',
      skills: Object.entries(skills).map(([id, version]) => ({ id, version }))
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ content, version: pinnedVersion, currentVersion }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runCheck(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd, env: { ...process.env, BINDRY_API_TOKEN: '' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const config = (apiBase, extra = {}) => JSON.stringify({ binderId: 'house', apiBase, ...extra });

test('a path-shaped skill whose version has moved on is reported as stale', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.4.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.0.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /path-matched instruction files/);
    assert.match(out, /! \.github\/instructions\/typescript\.instructions\.md — stale: compiled at 1\.0\.0, Binder now pins 1\.4\.0/);
    // The advice must not promise a sync clears a file for a skill that stopped being path-shaped.
    assert.match(out, /no longer matched by path leaves its old file behind; delete that one/);
  });
});

test('a path-shaped skill that is current is reported as up to date', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.4.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.4.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /= \.github\/instructions\/typescript\.instructions\.md — up to date \(1\.4\.0\)/);
    assert.doesNotMatch(out, /^\s*! /m);
  });
});

test('a Binder made only of path-shaped skills is checked, not dismissed as having no skills', async () => {
  // BIND-0262: on Copilot such a Binder compiles to no SKILL.md at all. The checker used to stop at
  // "no compiled skills found. Use the bindry-sync skill first" before looking at anything else.
  await withFakeApi({ skills: { [TS_SKILL]: '1.4.0', [SQL_SKILL]: '2.3.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.4.0'),
      '.github/instructions/sql.instructions.md': instructionFile(SQL_SKILL, '2.0.0')
    });

    const { out } = await runCheck(root);

    assert.doesNotMatch(out, /no compiled skills found/);
    assert.match(out, /= \.github\/instructions\/typescript\.instructions\.md — up to date/);
    assert.match(out, /! \.github\/instructions\/sql\.instructions\.md — stale: compiled at 2\.0\.0, Binder now pins 2\.3\.0/);
    // No SKILL.md existed, so no "0 skill(s)" summary line.
    assert.doesNotMatch(out, /0 skill\(s\)/);
  });
});

test('measures against the pinned version when the project is pinned', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0' }, pinnedVersion: '1.0.0', currentVersion: '2.0.0' }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase, { version: '1.0.0' }),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.0.0')
    });

    const { out } = await runCheck(root);

    // Holding exactly what was pinned is current, however far the Binder has moved since.
    assert.match(out, /= \.github\/instructions\/typescript\.instructions\.md — up to date \(1\.0\.0\)/);
    assert.doesNotMatch(out, /^\s*! /m);
  });
});

test('a pinned project\'s stale file is measured against the pinned version, and says so', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0' }, pinnedVersion: '1.0.0', currentVersion: '2.0.0' }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase, { version: '1.0.0' }),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '0.9.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /! \.github\/instructions\/typescript\.instructions\.md — stale against pinned 1\.0\.0: compiled at 0\.9\.0, that version pins 1\.0\.0/);
  });
});

test('names a file whose skill is not in this Binder without calling it wrong', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.github/instructions/typescript.instructions.md': instructionFile(TS_SKILL, '1.0.0'),
      '.github/instructions/other.instructions.md': instructionFile(OTHER_SKILL, '5.0.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /· \.github\/instructions\/other\.instructions\.md — its skill is not in this Binder, so it is not checked here/);
    assert.doesNotMatch(out, /! \.github\/instructions\/other/);
  });
});

test('adds nothing to the report of a repo that has no instruction files', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.claude/skills/typescript/SKILL.md': skillMd(TS_SKILL, '1.0.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /= typescript — up to date \(1\.0\.0\)/);
    assert.match(out, /bindry: all 1 skill\(s\) are up to date\./);
    assert.doesNotMatch(out, /path-matched/);
  });
});

test('reports the SKILL.md and the instruction file side by side without confusing them', async () => {
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0', [SQL_SKILL]: '2.3.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.claude/skills/typescript/SKILL.md': skillMd(TS_SKILL, '1.0.0'),
      '.github/instructions/sql.instructions.md': instructionFile(SQL_SKILL, '2.0.0')
    });

    const { out } = await runCheck(root);

    assert.match(out, /= typescript — up to date \(1\.0\.0\)/);
    assert.match(out, /bindry: all 1 skill\(s\) are up to date\./);
    assert.match(out, /! \.github\/instructions\/sql\.instructions\.md — stale/);
  });
});

test('a deleted instruction file is not reported, because nothing can say it should exist', async () => {
  // The export carries no appliesToPaths, so the checker cannot tell which skills should have a file.
  // A skill that was never path-shaped must not be reported as missing one.
  await withFakeApi({ skills: { [TS_SKILL]: '1.0.0' } }, async (apiBase) => {
    const root = repoWith({
      'bindry.config.json': config(apiBase),
      '.claude/skills/typescript/SKILL.md': skillMd(TS_SKILL, '1.0.0')
    });

    const { out } = await runCheck(root);

    assert.doesNotMatch(out, /missing/i);
  });
});
