import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAlwaysOnBlocks } from './check-drift.mjs';

// --- BIND-0243: seeing what is acting on every turn --------------------------------------------
//
// Skills live one per directory and never collide. Always-on blocks do: every Binder installed into
// a repo keeps its block in the SAME file, and nothing tracks the full set. Until this, the only way
// to know what was loaded on every turn was to open the file and read it.

const BLOCK = (slug, version, body) =>
  [
    `<!-- bindry:preamble binder=${slug} version=${version} -->`,
    body,
    `<!-- /bindry:preamble binder=${slug} -->`
  ].join('\n');

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'bindry-drift-'));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
}

test('finds every Binder keeping a block in one file', () => {
  const root = repoWith({
    'CLAUDE.md': `# My project\n\n${BLOCK('git-flow', '1.0.0', 'Be terse.')}\n\n${BLOCK('house-style', '2.1.0', 'No exclamation marks.')}\n`
  });

  const blocks = readAlwaysOnBlocks(root);

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.slug), ['git-flow', 'house-style']);
  assert.equal(blocks[0].version, '1.0.0');
});

test('scans every host file, not only this plugin own', () => {
  // A repo with more than one plugin installed genuinely has more than one always-on file, and
  // reporting only ours would under-report what is actually acting on the agent.
  const root = repoWith({
    'CLAUDE.md': BLOCK('git-flow', '1.0.0', 'Be terse.'),
    'AGENTS.md': BLOCK('git-flow', '1.0.0', 'Be terse.'),
    '.github/copilot-instructions.md': BLOCK('house-style', '2.1.0', 'No exclamation marks.')
  });

  const blocks = readAlwaysOnBlocks(root);

  assert.equal(blocks.length, 3);
  assert.deepEqual([...new Set(blocks.map((b) => b.file))].sort(), [
    '.github/copilot-instructions.md',
    'AGENTS.md',
    'CLAUDE.md'
  ]);
});

test('says nothing about a repo with no blocks', () => {
  // The common case today: every Binder in the Library has no preamble. A drift check that printed
  // an empty section for all of them would be noise on every run.
  assert.deepEqual(readAlwaysOnBlocks(repoWith({ 'CLAUDE.md': '# My project\n' })), []);
});

test('ignores a hand-written file that merely mentions bindry', () => {
  const root = repoWith({ 'CLAUDE.md': 'We use bindry:preamble blocks here, see the docs.\n' });

  assert.deepEqual(readAlwaysOnBlocks(root), []);
});

test('a block with no version is read rather than skipped', () => {
  // Nothing writes one today, but a hand-edited file might. Dropping it would under-report what is
  // loaded, which is the one thing this function exists to prevent.
  const root = repoWith({
    'CLAUDE.md': '<!-- bindry:preamble binder=git-flow -->\nBe terse.\n<!-- /bindry:preamble binder=git-flow -->\n'
  });

  const blocks = readAlwaysOnBlocks(root);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].version, '');
});
