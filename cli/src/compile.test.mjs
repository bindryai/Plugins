import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkill, renderPinComment, renderLiveComment, parsePinComment, parseLiveComment, slugify } from './compile.mjs';

const stack = { slug: 'git-flow', title: 'Git Flow' };
const binding = {
  id: 'b1111111-1111-1111-1111-111111111111',
  slug: 'branch-naming',
  title: 'Branch naming',
  version: '3',
  instructions: 'Name branches feature/<ticket>-<slug>.',
  constraints: ['No spaces in branch names.'],
  verification: ['Branch matches the pattern before pushing.']
};

test('renderSkill (pinned) embeds a parseable pin comment and the instructions', () => {
  const out = renderSkill(stack, binding, 'pinned');
  assert.match(out, /^---\nname: branch-naming\n/);
  assert.ok(out.includes(binding.instructions));
  assert.ok(out.includes('Constraints:'));
  assert.ok(out.includes('Verify before finishing:'));

  const pin = parsePinComment(out);
  assert.deepEqual(pin, { stack: 'git-flow', binding: binding.id, version: '3' });
  assert.equal(parseLiveComment(out), null);
});

test('renderSkill (live) embeds a parseable live comment instead of instructions', () => {
  const out = renderSkill(stack, binding, 'live');
  assert.ok(!out.includes(binding.instructions));
  assert.ok(out.includes('bindry.bindings.get'));

  const live = parseLiveComment(out);
  assert.deepEqual(live, { stack: 'git-flow', binding: binding.id });
  assert.equal(parsePinComment(out), null);
});

test('renderPinComment/renderLiveComment round-trip through their own parsers', () => {
  assert.deepEqual(parsePinComment(renderPinComment(stack, binding)), {
    stack: stack.slug,
    binding: binding.id,
    version: binding.version
  });
  assert.deepEqual(parseLiveComment(renderLiveComment(stack, binding)), {
    stack: stack.slug,
    binding: binding.id
  });
});

test('a standalone Binding (no Stack, BIND-0190) renders and parses with stack: null', () => {
  const out = renderSkill(null, binding, 'pinned');
  const pin = parsePinComment(out);
  assert.deepEqual(pin, { stack: null, binding: binding.id, version: '3' });
  assert.ok(!out.includes('stack='), 'a standalone pull must not fabricate a stack= field');

  const live = renderLiveComment(null, binding);
  assert.deepEqual(parseLiveComment(live), { stack: null, binding: binding.id });
});

test('slugify lowercases, strips symbols, and trims dashes', () => {
  assert.equal(slugify('Branch Naming!'), 'branch-naming');
  assert.equal(slugify('  --Weird__Title--  '), 'weird-title');
});
