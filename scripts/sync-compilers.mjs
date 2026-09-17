#!/usr/bin/env node
// Regenerates every non-Claude-Code platform's copy of the compiler and drift checker from the
// Claude Code copies, re-applying the known per-platform deltas listed below.
//
// Each plugin has to bundle its own scripts (installed plugins live at independent, versioned cache
// paths per platform, with no shared filesystem layout to import from), so the duplication is real and
// unavoidable. What is avoidable is the copies silently drifting: edit the Claude Code copy, run
// this, and the other copies are regenerated rather than hand-patched. `validate.mjs` runs the same
// transform in check-only mode and fails CI if a committed copy doesn't match, so a hand-edit to one
// file can't land without the others.
//
// Usage: node scripts/sync-compilers.mjs [--check]
//
// Adding a platform: add an entry to PLATFORMS with its deltas rather than forking a copy by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CODEX_COMPILER_PROVENANCE = `//
// This is Codex's copy of the same compiler that ships with the Claude Code plugin
// (../../claude-code/scripts/compile-stack.mjs) — identical logic, since both platforms use the
// same SKILL.md format. Kept as a self-contained copy rather than a shared import: installed
// plugins live at independent, versioned cache paths per platform with no guaranteed shared
// filesystem layout, so each plugin bundles its own scripts. The only behavioral difference is
// the default output directory below (Codex's project-local skills live in .agents/skills, not
// .claude/skills).
`;

const COPILOT_COMPILER_PROVENANCE = `//
// This is GitHub Copilot's copy of the same compiler that ships with the Claude Code plugin
// (../../claude-code/scripts/compile-stack.mjs) — identical logic, since Copilot uses the same
// SKILL.md format. Kept as a self-contained copy rather than a shared import: installed plugins
// live at independent, versioned cache paths per platform with no guaranteed shared filesystem
// layout, so each plugin bundles its own scripts. The only behavioral difference is the default
// output directory below (Copilot's first project-local skills directory is .github/skills, not
// .claude/skills).
`;

/** Deltas shared by every skill-only platform (no slash commands) for the drift checker. */
function checkerDeltas(platformName, outDir) {
  return [
    [
      '// unless overridden with flags, so a plain `/bindry-check` works right after a `/bindry-sync`.\n',
      '// unless overridden with flags, so running this right after a sync needs no arguments.\n' +
      '//\n' +
      `// This is ${platformName}'s copy of the same checker that ships with the Claude Code plugin\n` +
      '// (../../claude-code/scripts/check-drift.mjs) — see compile-stack.mjs in this directory for why\n' +
      "// it's a self-contained copy rather than a shared import.\n"
    ],
    ["dir: '.claude/skills'", `dir: '${outDir}'`],
    ['run /bindry-sync at least once first,', 'use the bindry-sync skill at least once first,'],
    ['(or run /bindry-sync at least once so', '(or use the bindry-sync skill at least once so'],
    ['Run /bindry-sync first.', 'Use the bindry-sync skill first.'],
    ['(not compiled by /bindry-sync?)', '(not compiled by bindry-sync?)'],
    ["run /bindry-sync to update the stale skill(s).", 'use the bindry-sync skill to update the stale skill(s).']
  ];
}

/** Deltas shared by every skill-only platform for the compiler. */
function compilerDeltas(platformLabel, outDir, provenance) {
  return [
    [
      '// Compiles a Bindry Stack export into one Claude Code skill per Binding.',
      `// Compiles a Bindry Stack export into one ${platformLabel} skill per Binding.`
    ],
    [
      '// connected separately — see commands/bindry-connect.md.',
      '// connected separately — see skills/bindry-connect/SKILL.md.'
    ],
    [
      "// snapshot behavior); the mode is remembered in bindry.config.json like the Stack id and API base.\n",
      "// snapshot behavior); the mode is remembered in bindry.config.json like the Stack id and API base.\n" + provenance
    ],
    ["out: '.claude/skills'", `out: '${outDir}'`],
    [
      "guess. If the Bindry MCP server isn\\'t connected yet, run `/bindry-connect` first.",
      "guess. If the Bindry MCP server isn\\'t connected yet, use the `bindry-connect` skill first."
    ]
  ];
}

const PLATFORMS = {
  codex: {
    'compile-stack.mjs': compilerDeltas('Codex', '.agents/skills', CODEX_COMPILER_PROVENANCE),
    'check-drift.mjs': checkerDeltas('Codex', '.agents/skills')
  },
  copilot: {
    'compile-stack.mjs': compilerDeltas('GitHub Copilot', '.github/skills', COPILOT_COMPILER_PROVENANCE),
    'check-drift.mjs': checkerDeltas('GitHub Copilot', '.github/skills')
  }
};

/** Applies a platform's deltas to the Claude Code copy of `script`. Throws if a delta no longer matches. */
export function renderPlatformScript(platform, script) {
  const raw = readFileSync(resolve(ROOT, 'claude-code/scripts', script), 'utf8');
  const crlf = raw.includes('\r\n');
  let out = raw.replace(/\r\n/g, '\n');
  for (const [from, to] of PLATFORMS[platform][script]) {
    if (!out.includes(from)) {
      throw new Error(
        `sync-compilers: ${platform}/${script} delta no longer matches the Claude Code copy: ` +
        `${JSON.stringify(from.slice(0, 70))}. Update the deltas in scripts/sync-compilers.mjs.`
      );
    }
    out = out.replace(from, to);
  }
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** Every generated copy, as { platform, script, path } with path relative to the repo root. */
export function generatedScripts() {
  return Object.entries(PLATFORMS).flatMap(([platform, scripts]) =>
    Object.keys(scripts).map((script) => ({ platform, script, path: `${platform}/scripts/${script}` }))
  );
}

/** True when the committed copy already matches what the transform would produce. */
export function scriptInSync(platform, script) {
  return readFileSync(resolve(ROOT, platform, 'scripts', script), 'utf8') === renderPlatformScript(platform, script);
}

// Only act when run directly — validate.mjs imports the functions above.
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  let outOfSync = 0;
  for (const { platform, script, path } of generatedScripts()) {
    const target = resolve(ROOT, path);
    const rendered = renderPlatformScript(platform, script);
    let before = null;
    try {
      before = readFileSync(target, 'utf8');
    } catch {
      // Not generated yet — written below, or reported as out of sync in --check mode.
    }
    if (before === rendered) {
      console.log(`${path}: in sync`);
    } else if (check) {
      console.error(`${path}: OUT OF SYNC — run: node scripts/sync-compilers.mjs`);
      outOfSync++;
    } else {
      writeFileSync(target, rendered, 'utf8');
      console.log(`${path}: regenerated`);
    }
  }
  if (outOfSync > 0) process.exit(1);
}
