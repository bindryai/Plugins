import { test } from 'node:test';
import assert from 'node:assert/strict';

// The pin comment format lives in FOUR places: the CLI (cli/src/compile.mjs) writes it, and each
// host plugin has its own copy of the parser because each ships as a standalone installable. They
// have to agree, and nothing checked that they did.
//
// BIND-0259: BIND-0252 added an optional trailing `binder-version=` to the CLI's writer and parser
// and left the three plugin copies behind. The result was not a crash — it was worse. An unmatched
// pin is indistinguishable from no pin, so /bindry-check reported a folder of real compiled skills
// as "no bindry:pin or bindry:live comment found, can't check (not compiled by /bindry-sync?)",
// telling people their own Bindry output was not Bindry's. The codebase already knew this failure
// mode: `hasLegacyComment` exists so 0.1.x markers would not read as "no skills found".
//
// Lives under claude-code/scripts because that is the only directory CI globs for script tests
// (.github/workflows/validate.yml runs `node --test claude-code/scripts/*.test.mjs`). It imports
// all three hosts deliberately. Widening the CI glob would be the better fix; until then, putting
// the cross-host test where CI actually looks is what keeps it running.

import { parsePinComment as claudeCode, renderPinComment as renderClaudeCode } from './compile-binder.mjs';
import { parsePinComment as codex } from '../../codex/scripts/compile-binder.mjs';
import { parsePinComment as copilot } from '../../copilot/scripts/compile-binder.mjs';
import { parsePinComment as cli, renderPinComment as renderCli } from '../../cli/src/compile.mjs';

const HOSTS = [
  ['claude-code', claudeCode],
  ['codex', codex],
  ['copilot', copilot]
];

// Exactly what `bindry pull --binder-version 2.1.0` writes today.
const WITH_BINDER_VERSION =
  '<!-- bindry:pin binder=git-flow skill=aaaa-1111 version=3 binder-version=2.1.0 -->';

// What every SKILL.md on disk before BIND-0252 looks like.
const WITHOUT_BINDER_VERSION = '<!-- bindry:pin binder=git-flow skill=aaaa-1111 version=3 -->';

test('every host parses a pin that carries binder-version', () => {
  for (const [name, parse] of HOSTS) {
    const pin = parse(WITH_BINDER_VERSION);
    assert.ok(pin, `${name} failed to parse a pin written by the current CLI`);
    assert.equal(pin.skill, 'aaaa-1111', name);
    // The skill's own version must not absorb the trailing field.
    assert.equal(pin.version, '3', `${name} mis-parsed the skill version`);
    assert.equal(pin.binderVersion, '2.1.0', name);
  }
});

test('every host still parses a pin written before binder-version existed', () => {
  for (const [name, parse] of HOSTS) {
    const pin = parse(WITHOUT_BINDER_VERSION);
    assert.ok(pin, `${name} stopped parsing pre-BIND-0252 pins`);
    assert.equal(pin.version, '3', name);
    assert.equal(pin.binderVersion, null, `${name} should report no Binder version, not undefined`);
  }
});

test('every host agrees with the CLI, which is the writer', () => {
  // The CLI is the only one that writes `binder-version=`, so it is the reference. Comparing the
  // parsed result rather than the regex source lets each host keep its own copy while still being
  // held to one format.
  const reference = cli(WITH_BINDER_VERSION);
  for (const [name, parse] of HOSTS) {
    assert.deepEqual(parse(WITH_BINDER_VERSION), reference, `${name} disagrees with the CLI`);
  }
});

test('a pin the plugin itself writes round-trips through every host and the CLI', () => {
  // The plugin writes no Binder version, so this is the format a /bindry-sync install produces.
  // It must stay readable by the CLI's `bindry check` as well as by the plugins' own.
  const written = renderClaudeCode({ slug: 'git-flow' }, { id: 'aaaa-1111', version: '3' });

  for (const [name, parse] of HOSTS) {
    assert.ok(parse(written), `${name} cannot read what the plugin wrote`);
  }
  assert.ok(cli(written), 'the CLI cannot read what the plugin wrote');
});

test('a pin the CLI writes at a version round-trips through every host', () => {
  const written = renderCli({ slug: 'git-flow', version: '2.1.0' }, { id: 'aaaa-1111', version: '3' });

  assert.match(written, /binder-version=2\.1\.0/);
  for (const [name, parse] of HOSTS) {
    const pin = parse(written);
    assert.ok(pin, `${name} cannot read what the CLI wrote`);
    assert.equal(pin.binderVersion, '2.1.0', name);
  }
});
