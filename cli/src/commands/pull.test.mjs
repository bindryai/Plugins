import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from './pull.mjs';

test('resolveTarget maps CLI-friendly names to the API enum names', () => {
  assert.equal(resolveTarget(undefined), 'SkillBundle');
  assert.equal(resolveTarget('skill-bundle'), 'SkillBundle');
  assert.equal(resolveTarget('markdown'), 'Markdown');
  assert.equal(resolveTarget('agents-md'), 'AgentsMd');
  assert.equal(resolveTarget('copy'), 'Copy');
});

test('resolveTarget rejects an unknown target with the valid options listed', () => {
  assert.throws(() => resolveTarget('yaml'), /unknown --target "yaml".*skill-bundle/);
});
