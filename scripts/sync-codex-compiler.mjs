#!/usr/bin/env node
// Regenerates codex/scripts/compile-stack.mjs from the Claude Code copy, re-applying the known
// Codex-only deltas listed below.
//
// Each plugin has to bundle its own scripts (installed plugins live at independent, versioned cache
// paths per platform, with no shared filesystem layout to import from), so the duplication is real and
// unavoidable. What is avoidable is the two copies silently drifting: edit the Claude Code copy, run
// this, and the Codex copy is regenerated rather than hand-patched. `validate.mjs` runs the same
// transform in check-only mode and fails CI if the committed Codex copy doesn't match, so a
// hand-edit to one file can't land without the other.
//
// Usage: node scripts/sync-codex-compiler.mjs [--check]
//
// Adding a third platform: add its deltas the same way rather than forking a third copy by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CC = resolve(ROOT, 'claude-code/scripts/compile-stack.mjs');
const CX = resolve(ROOT, 'codex/scripts/compile-stack.mjs');

const PROVENANCE = `//
// This is Codex's copy of the same compiler that ships with the Claude Code plugin
// (../../claude-code/scripts/compile-stack.mjs) — identical logic, since both platforms use the
// same SKILL.md format. Kept as a self-contained copy rather than a shared import: installed
// plugins live at independent, versioned cache paths per platform with no guaranteed shared
// filesystem layout, so each plugin bundles its own scripts. The only behavioral difference is
// the default output directory below (Codex's project-local skills live in .agents/skills, not
// .claude/skills).
`;

const deltas = [
  [
    '// Compiles a Bindry Stack export into one Claude Code skill per Binding.',
    '// Compiles a Bindry Stack export into one Codex skill per Binding.'
  ],
  [
    '// connected separately — see commands/bindry-connect.md.',
    '// connected separately — see skills/bindry-connect/SKILL.md.'
  ],
  [
    "// snapshot behavior); the mode is remembered in bindry.config.json like the Stack id and API base.\n",
    "// snapshot behavior); the mode is remembered in bindry.config.json like the Stack id and API base.\n" + PROVENANCE
  ],
  ["out: '.claude/skills'", "out: '.agents/skills'"],
  [
    "guess. If the Bindry MCP server isn\\'t connected yet, run `/bindry-connect` first.",
    "guess. If the Bindry MCP server isn\\'t connected yet, use the `bindry-connect` skill first."
  ]
];

/** Applies the Codex deltas to the Claude Code compiler source. Throws if a delta no longer matches. */
export function renderCodexCompiler() {
  const raw = readFileSync(CC, 'utf8');
  const crlf = raw.includes('\r\n');
  let out = raw.replace(/\r\n/g, '\n');
  for (const [from, to] of deltas) {
    if (!out.includes(from)) {
      throw new Error(
        `sync-codex-compiler: delta no longer matches the Claude Code copy: ${JSON.stringify(from.slice(0, 70))}. ` +
        `Update the deltas list in scripts/sync-codex-compiler.mjs.`
      );
    }
    out = out.replace(from, to);
  }
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** True when the committed Codex copy already matches what the transform would produce. */
export function codexCompilerInSync() {
  return readFileSync(CX, 'utf8') === renderCodexCompiler();
}

// Only act when run directly — validate.mjs imports the two functions above.
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--check')) {
    if (codexCompilerInSync()) {
      console.log('codex compiler is in sync');
    } else {
      console.error('codex compiler is OUT OF SYNC — run: node scripts/sync-codex-compiler.mjs');
      process.exit(1);
    }
  } else {
    const rendered = renderCodexCompiler();
    const before = readFileSync(CX, 'utf8');
    writeFileSync(CX, rendered, 'utf8');
    console.log(before === rendered ? 'codex compiler already in sync' : 'codex compiler regenerated');
  }
}
