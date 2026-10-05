import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// BIND-0262: a Copilot Binder whose skills are ALL path-shaped compiled to nothing.
//
// On Copilot, a skill with appliesToPaths renders to .github/instructions/<slug>.instructions.md
// INSTEAD OF a SKILL.md — SkillFileRenderer says so outright ("INSTEAD OF the SKILL.md, not as well
// as") and SkillFileRendererTests asserts rendered.Files is empty. So "a Binder of file-shaped
// conventions" — TypeScript conventions, SQL conventions, migration rules, all naturally
// path-scoped — exports with an EMPTY skills array and everything in instructions[].
//
// The compilers' guard required a non-empty skills array and ran BEFORE the instructions loop, so
// that valid export was refused with "is this a Bindry Binder export?" — telling the user their own
// Binder was not Bindry output, which sends them looking for a corrupt download. Same failure shape
// as BIND-0259: our own valid output reported as foreign.
//
// Tested by SUBPROCESS rather than by import, because the guard lives inside main() and the thing
// worth protecting is the end-to-end behaviour: exit code, files on disk, and what the summary says.
//
// Lives under claude-code/scripts because that is the only directory CI globs for script tests
// (.github/workflows/validate.yml runs `node --test claude-code/scripts/*.test.mjs`). It exercises
// all three host copies deliberately — the bug was reachable on Copilot, but the guard is shared and
// the generated copies must not drift back.

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = resolve(HERE, '../..');

const COMPILERS = [
  ['claude-code', join(PLUGINS, 'claude-code/scripts/compile-binder.mjs')],
  ['codex', join(PLUGINS, 'codex/scripts/compile-binder.mjs')],
  ['copilot', join(PLUGINS, 'copilot/scripts/compile-binder.mjs')]
];

const INSTRUCTION_PATH = '.github/instructions/typescript-conventions.instructions.md';

/** Exactly what the server exports for a Binder whose every skill is path-shaped. */
const INSTRUCTIONS_ONLY = {
  slug: 'file-shaped-conventions',
  title: 'File-Shaped Conventions',
  tokenEstimate: 90,
  skills: [],
  instructions: [
    {
      path: INSTRUCTION_PATH,
      content: '---\napplyTo: "**/*.ts"\n---\n\nPrefer const over let.\n'
    }
  ]
};

function compile(compilerPath, binder) {
  const dir = mkdtempSync(join(tmpdir(), 'bind-0262-'));
  try {
    const bundle = join(dir, 'bundle.json');
    writeFileSync(bundle, JSON.stringify(binder), 'utf8');
    const run = spawnSync(process.execPath, [compilerPath, bundle, '--out', '.github/skills'], {
      cwd: dir,
      encoding: 'utf8'
    });
    const written = join(dir, INSTRUCTION_PATH);
    return {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      wrote: existsSync(written),
      contents: existsSync(written) ? readFileSync(written, 'utf8') : null
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, compilerPath] of COMPILERS) {
  test(`${name}: a Binder with only path-matched instructions compiles`, () => {
    const result = compile(compilerPath, INSTRUCTIONS_ONLY);

    assert.equal(result.status, 0, `${name} refused a valid export: ${result.output}`);
    assert.ok(result.wrote, `${name} wrote no instruction file: ${result.output}`);
    assert.match(result.contents, /^---\napplyTo: "\*\*\/\*\.ts"\n---/, `${name} mangled the file`);
  });

  test(`${name}: the summary does not read as a failed compile`, () => {
    const result = compile(compilerPath, INSTRUCTIONS_ONLY);

    // "0 skill(s) written" on its own is what a user reads as "nothing happened". The instruction
    // files that WERE written have to appear in the count, or the fix is invisible to the person it
    // was for.
    assert.match(
      result.output,
      /1 path-matched instruction file\(s\) written/,
      `${name} did not report the instruction file it wrote: ${result.output}`
    );
  });

  test(`${name}: an export with neither skills nor instructions is still refused`, () => {
    // The guard was relaxed, not removed. Without this, deleting the guard outright would pass
    // every other test in this file.
    const result = compile(compilerPath, { slug: 'empty', title: 'Empty', skills: [], instructions: [] });

    assert.notEqual(result.status, 0, `${name} accepted an export with nothing to write`);
    assert.match(
      result.output,
      /skills/,
      `${name} refused it without naming what was missing: ${result.output}`
    );
  });

  test(`${name}: an export with no slug is still refused`, () => {
    const result = compile(compilerPath, { title: 'No slug', instructions: INSTRUCTIONS_ONLY.instructions });

    assert.notEqual(result.status, 0, `${name} accepted an export with no slug`);
    assert.match(result.output, /slug/, `${name} refused it without naming slug: ${result.output}`);
  });

  test(`${name}: a normal Binder with skills still compiles`, () => {
    // The regression this fix could plausibly cause: breaking the ordinary path while widening it.
    const dir = mkdtempSync(join(tmpdir(), 'bind-0262-ok-'));
    try {
      const bundle = join(dir, 'bundle.json');
      writeFileSync(bundle, JSON.stringify({
        slug: 'ordinary',
        title: 'Ordinary',
        tokenEstimate: 50,
        skills: [{
          id: 'aaaaaaaa-0262-4000-8000-00000000000a',
          slug: 'branch-hygiene',
          title: 'Branch Hygiene',
          version: '1.0.0',
          appliesWhen: ['starting new work'],
          doesNotApplyWhen: [],
          instructions: 'Branch from development.',
          constraints: [],
          verificationChecklist: []
        }]
      }), 'utf8');
      mkdirSync(join(dir, 'out'), { recursive: true });

      const run = spawnSync(process.execPath, [compilerPath, bundle, '--out', 'out'], {
        cwd: dir,
        encoding: 'utf8'
      });

      assert.equal(run.status, 0, `${name} broke the ordinary path: ${run.stdout}${run.stderr}`);
      assert.ok(
        existsSync(join(dir, 'out/branch-hygiene/SKILL.md')),
        `${name} wrote no SKILL.md for an ordinary Binder`
      );
      assert.match(run.stdout, /1 skill\(s\)/, `${name} miscounted an ordinary compile`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
