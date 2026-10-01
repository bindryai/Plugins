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
