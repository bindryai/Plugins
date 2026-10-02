import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkill, renderPinComment, renderLiveComment, parsePinComment, parseLiveComment, hasLegacyComment, slugify } from './compile.mjs';

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
  assert.deepEqual(pin, { binder: 'git-flow', skill: skill.id, version: '3' });
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
    version: skill.version
  });
  assert.deepEqual(parseLiveComment(renderLiveComment(binder, skill)), {
    binder: binder.slug,
    skill: skill.id
  });
});

test('a standalone Skill (no Binder, BIND-0190) renders and parses with binder: null', () => {
  const out = renderSkill(null, skill, 'pinned');
  const pin = parsePinComment(out);
  assert.deepEqual(pin, { binder: null, skill: skill.id, version: '3' });
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
