import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkill, renderPinComment, renderLiveComment, parsePinComment, parseLiveComment, hasLegacyComment, slugify, preamblePathFor, preambleBlockPattern, splicePreamble, removePreamble, parsePreambleSlug } from './compile.mjs';

const binder = { slug: 'git-flow', title: 'Git Flow' };
const skill = {
  id: 'b1111111-1111-1111-1111-111111111111',
  slug: 'branch-naming',
  title: 'Branch naming',
  version: '3',
  instructions: 'Name branches feature/<ticket>-<slug>.',
  constraints: ['No spaces in branch names.'],
  verification: ['Branch matches the pattern before pushing.']
};

test('renderSkill (pinned) embeds a parseable pin comment and the instructions', () => {
  const out = renderSkill(binder, skill, 'pinned');
  assert.match(out, /^---\nname: branch-naming\n/);
  assert.ok(out.includes(skill.instructions));
  assert.ok(out.includes('Constraints:'));
  assert.ok(out.includes('Verify before finishing:'));

  const pin = parsePinComment(out);
  assert.deepEqual(pin, { binder: 'git-flow', skill: skill.id, version: '3', binderVersion: null });
  assert.equal(parseLiveComment(out), null);
});

test('renderSkill (live) embeds a parseable live comment instead of instructions', () => {
  const out = renderSkill(binder, skill, 'live');
  assert.ok(!out.includes(skill.instructions));
  assert.ok(out.includes('bindry.skills.get'));

  const live = parseLiveComment(out);
  assert.deepEqual(live, { binder: 'git-flow', skill: skill.id });
  assert.equal(parsePinComment(out), null);
});

test('renderPinComment/renderLiveComment round-trip through their own parsers', () => {
  assert.deepEqual(parsePinComment(renderPinComment(binder, skill)), {
    binder: binder.slug,
    skill: skill.id,
    version: skill.version,
    binderVersion: null
  });
  assert.deepEqual(parseLiveComment(renderLiveComment(binder, skill)), {
    binder: binder.slug,
    skill: skill.id
  });
});

test('a pin written before binder-version existed still parses (BIND-0252)', () => {
  // The regex gained an optional trailing field. Every SKILL.md already on disk was written without
  // it, and a pin that stops parsing reads to the user as "no compiled skills found" against a
  // folder full of them — with nothing on screen connecting that to a CLI upgrade.
  const legacy = '<!-- bindry:pin binder=git-flow skill=aaaa-1111 version=3 -->';

  assert.deepEqual(parsePinComment(legacy), {
    binder: 'git-flow',
    skill: 'aaaa-1111',
    version: '3',
    binderVersion: null
  });
});

test('a pin records the Binder version it came from when one was pinned (BIND-0252)', () => {
  const pinned = parsePinComment(renderPinComment({ slug: 'git-flow', version: '2.1.0' }, skill));

  assert.equal(pinned.binderVersion, '2.1.0');
  // The skill's own version still says what the file contains — the two answer different questions.
  assert.equal(pinned.version, skill.version);
});

test('a standalone Skill (no Binder, BIND-0190) renders and parses with binder: null', () => {
  const out = renderSkill(null, skill, 'pinned');
  const pin = parsePinComment(out);
  assert.deepEqual(pin, { binder: null, skill: skill.id, version: '3', binderVersion: null });
  assert.ok(!out.includes('binder='), 'a standalone pull must not fabricate a binder= field');

  const live = renderLiveComment(null, skill);
  assert.deepEqual(parseLiveComment(live), { binder: null, skill: skill.id });
});

test('slugify lowercases, strips symbols, and trims dashes', () => {
  assert.equal(slugify('Branch Naming!'), 'branch-naming');
  assert.equal(slugify('  --Weird__Title--  '), 'weird-title');
});

// The other half of F1 decision 1. A SKILL.md pulled by 0.1.x carries `stack=`/`binding=`, which
// parses as neither a pin nor a live marker — so without recognising it, `bindry check` reports
// "no compiled skills with a marker found" against a folder full of them. The user did not write
// those files, so nothing on screen would connect that message to an upgrade.
test('a marker written by 0.1.x is recognised as legacy, not as absent', () => {
  const legacyPin = '<!-- bindry:pin stack=git-flow binding=11111111-1111-1111-1111-111111111111 version=1.0.0 -->';
  const legacyLive = '<!-- bindry:live stack=git-flow binding=11111111-1111-1111-1111-111111111111 -->';
  const legacyStandalone = '<!-- bindry:pin binding=11111111-1111-1111-1111-111111111111 version=1.0.0 -->';

  for (const marker of [legacyPin, legacyLive, legacyStandalone]) {
    assert.equal(parsePinComment(marker), null, 'a legacy marker must not parse as a current pin');
    assert.equal(parseLiveComment(marker), null, 'a legacy marker must not parse as a current live marker');
    assert.ok(hasLegacyComment(marker), `should be recognised as legacy: ${marker}`);
  }
});

test('a current marker is not mistaken for a legacy one', () => {
  // The detector must not fire on 0.2.0 output, or every healthy folder would be told to re-pull.
  const current = renderPinComment({ slug: 'git-flow' }, { id: '11111111-1111-1111-1111-111111111111', version: '1.0.0' });
  assert.ok(!hasLegacyComment(current));
  assert.ok(parsePinComment(current));
});

// --- BIND-0238: exclusions belong where the choice is made -------------------------------------

const describedFrom = (contents) => contents.match(/^description: (.*)$/m)[1];

test('exclusions reach the description, not only the body', () => {
  // The whole point of the card. Every host loads name + description for all skills and loads the
  // body only after one has been chosen, so an exclusion that lives solely in the body arrives
  // too late to prevent a wrong pick.
  const described = describedFrom(
    renderSkill(binder, { ...skill, appliesWhen: ['naming a branch'], doesNotApplyWhen: ['tagging a release'] }, 'pinned')
  );

  assert.match(described, /Use when: naming a branch\./);
  assert.match(described, /Not for: tagging a release\./);
});

test('a skill with no exclusions renders exactly what it always did', () => {
  // The compatibility guarantee. Adding this feature must not change a single byte for the
  // Binders already published, or every installed repo churns for no benefit.
  const described = describedFrom(renderSkill(binder, { ...skill, appliesWhen: ['naming a branch'] }, 'pinned'));

  assert.equal(described, 'Branch naming. Use when: naming a branch.');
});

test('the body still carries the exclusions too', () => {
  // This adds a surface, it does not move one: once the skill IS loaded, the full list is still
  // the more useful place to read the detail.
  const contents = renderSkill(binder, { ...skill, doesNotApplyWhen: ['tagging a release'] }, 'pinned');

  assert.match(contents, /Does not apply when:\n- tagging a release/);
});

test('exclusions are dropped whole, never cut mid-phrase', () => {
  // Half a condition reads as a DIFFERENT condition. A rule that quietly means something else is
  // worse than one that is simply absent, so the cap drops whole clauses from the end.
  const long = 'x'.repeat(200);
  const described = describedFrom(
    renderSkill(binder, { ...skill, appliesWhen: ['naming a branch'], doesNotApplyWhen: [long, long, long] }, 'pinned')
  );

  assert.ok(described.length <= 500, `description was ${described.length} chars`);
  // Assert the invariant, not an arithmetic count: at least one survives, at least one was
  // dropped, and every survivor is whole. A hard-coded count would only test the fixture title.
  const kept = described.split(long).length - 1;
  assert.ok(kept >= 1 && kept <= 2, `kept ${kept}`);
  assert.ok(described.endsWith('.'));
});

test('the cap never shortens the title or the "use when" clause', () => {
  // The cap governs what we ADD. An author with a very long appliesWhen list had that output
  // before this feature existed and must keep it — we are not entitled to trim their work because
  // we decided to append to it.
  const head = 'y'.repeat(600);
  const described = describedFrom(
    renderSkill(binder, { ...skill, appliesWhen: [head], doesNotApplyWhen: ['tagging a release'] }, 'pinned')
  );

  assert.ok(described.includes(head), 'the existing clause must survive in full');
  assert.ok(!described.includes('Not for:'), 'nothing is added when there is no room for it');
});

// --- BIND-0240: the always-on block, spliced into a file the user owns -------------------------
//
// These functions edit CLAUDE.md and AGENTS.md — files people wrote by hand, that long predate
// Bindry, and that may hold more than one Binder's block. Every test here is about not damaging
// something that was not ours to touch.

const BLOCK = (slug, body) =>
  [
    `<!-- bindry:preamble binder=${slug} version=1.0.0 -->`,
    '<!-- Managed by Bindry. Edits inside this block are overwritten on the next sync. -->',
    '',
    body,
    '',
    `<!-- /bindry:preamble binder=${slug} -->`
  ].join('\n');

test('each host gets its own always-on file', () => {
  assert.equal(preamblePathFor('claude-code'), 'CLAUDE.md');
  assert.equal(preamblePathFor('codex'), 'AGENTS.md');
  // Copilot reads AGENTS.md too, so it deliberately gets its own file: a repo with both the Codex
  // and Copilot plugins would otherwise apply the same persona twice to the same agent.
  assert.equal(preamblePathFor('copilot'), '.github/copilot-instructions.md');
});

test('an empty file just gets the block', () => {
  const result = splicePreamble('', BLOCK('house-style', 'Write plainly.'));

  assert.ok(result.startsWith('<!-- bindry:preamble binder=house-style'));
  assert.ok(result.endsWith('\n'));
});

test("a hand-written file keeps every byte it had", () => {
  // The one that matters most. People keep real instructions in CLAUDE.md, and a tool that
  // clobbered them would destroy work that was never ours.
  const existing = '# My project\n\nAlways run the linter before committing.\n';

  const result = splicePreamble(existing, BLOCK('house-style', 'Write plainly.'));

  assert.ok(result.startsWith(existing.trimEnd()));
  assert.match(result, /Always run the linter before committing\./);
  assert.match(result, /bindry:preamble binder=house-style/);
});

test('compiling twice changes nothing the second time', () => {
  // Idempotency is what keeps this out of the user's diff. A block that rewrote itself every sync
  // would show up as a change in every commit and train people to ignore it.
  const once = splicePreamble('# My project\n', BLOCK('house-style', 'Write plainly.'));
  const twice = splicePreamble(once, BLOCK('house-style', 'Write plainly.'));

  assert.equal(twice, once);
});

test('an updated preamble replaces the block in place', () => {
  const before = splicePreamble('# My project\n', BLOCK('house-style', 'Write plainly.'));
  const after = splicePreamble(before, BLOCK('house-style', 'Write in British English.'));

  assert.match(after, /Write in British English\./);
  assert.doesNotMatch(after, /Write plainly\./);
  // Count OPENING markers only — the closing marker also contains "bindry:preamble binder=".
  assert.equal(after.match(/<!-- bindry:preamble binder=house-style/g).length, 1);
  assert.match(after, /# My project/);
});

test('two Binders coexist, and updating one leaves the other untouched', () => {
  // The whole point of keying the block by slug. Without it the second Binder's compile would
  // silently delete the first Binder's persona, with no error and nothing on screen.
  let file = splicePreamble('', BLOCK('acme-voice', 'Be warm.'));
  file = splicePreamble(file, BLOCK('platform-standards', 'Be precise.'));

  const updated = splicePreamble(file, BLOCK('acme-voice', 'Be warmer.'));

  assert.match(updated, /Be warmer\./);
  assert.match(updated, /Be precise\./);
  assert.doesNotMatch(updated, /Be warm\.\n/);
  assert.equal(updated.match(/<!-- bindry:preamble binder=/g).length, 2);
});

test('a slug that is a prefix of another does not eat its block', () => {
  // `binder=acme` must not match `binder=acme-voice`.
  //
  // ORDER MATTERS, and this is the order that actually exercises it. With the longer slug FIRST,
  // a pattern lacking the whitespace guard starts matching at acme-voice's OPENING marker and runs
  // to acme's CLOSING marker — swallowing both blocks and deleting a different Binder's persona.
  // With the short slug first it accidentally still works, which is why the first version of this
  // test passed against the broken pattern.
  let file = splicePreamble('', BLOCK('acme-voice', 'Long.'));
  file = splicePreamble(file, BLOCK('acme', 'Short.'));

  const updated = splicePreamble(file, BLOCK('acme', 'Short, revised.'));

  assert.match(updated, /Short, revised\./);
  assert.match(updated, /Long\./);
  assert.equal(updated.match(/<!-- bindry:preamble binder=/g).length, 2);
});

test('an uninstall removes only its own block and leaves no gap', () => {
  let file = splicePreamble('# My project\n', BLOCK('acme-voice', 'Be warm.'));
  file = splicePreamble(file, BLOCK('platform-standards', 'Be precise.'));

  const result = removePreamble(file, 'acme-voice');

  assert.doesNotMatch(result, /Be warm\./);
  assert.match(result, /Be precise\./);
  assert.match(result, /# My project/);
  assert.doesNotMatch(result, /\n{3,}/);
});

test('removing a block that is not there is a no-op', () => {
  const existing = '# My project\n';
  assert.equal(removePreamble(existing, 'never-installed'), existing);
});

test('a malformed slug throws rather than silently matching nothing', () => {
  // A pattern that cannot match looks exactly like "this Binder has no block yet", so a compile
  // would append a second one every run. Better to fail loudly at the caller.
  assert.throws(() => preambleBlockPattern('Not A Slug'), /not a valid Binder slug/);
});

// --- BIND-0243: the block keys itself, so two writers cannot disagree -------------------------

test('the block is found by the slug it carries, not one supplied alongside it', () => {
  // The bug this replaces: `bindry pull` passed slugify(id) — what the user TYPED — while the
  // block carried the Binder's real slug. Pull by GUID and the pattern searched for
  // `binder=3f2504e0-…` inside a block saying `binder=git-flow`, never matched, and appended
  // another copy on every single pull. Three pulls produced three blocks.
  //
  // splicePreamble now reads the slug out of the block it is writing, so the string being searched
  // for and the string being written are the same string.
  const block = BLOCK('git-flow', 'Be terse.');

  let file = '';
  for (let i = 0; i < 3; i++) file = splicePreamble(file, block);

  assert.equal(file.match(/<!-- bindry:preamble binder=/g).length, 1);
});

test('parsePreambleSlug reads the slug out of a rendered block', () => {
  assert.equal(parsePreambleSlug(BLOCK('house-style', 'Be warm.')), 'house-style');
});

test('a block with no readable marker throws rather than appending forever', () => {
  // Silence is what made the original bug invisible: an unmatched pattern looks exactly like
  // "this Binder has no block yet", so the compile appends instead of reporting anything.
  assert.throws(() => splicePreamble('', 'just some text with no marker'), /no readable/);
});
