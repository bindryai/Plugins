#!/usr/bin/env node
// Reports which compiled skills are stale against their Binder's current pinned Skill
// versions. Read-only — never re-syncs or writes anything.
//
// Usage:
//   node check-drift.mjs [--dir <skills-dir>] [--api-base <url>] [--token <api-key>] [--version <v>]
//
// Reuses bindry.config.json (written by compile-binder.mjs) for the Binder id, API base and pinned
// version unless overridden with flags, so running this right after a sync needs no arguments.
//
// This is GitHub Copilot's copy of the same checker that ships with the Claude Code plugin
// (../../claude-code/scripts/check-drift.mjs) — see compile-binder.mjs in this directory for why
// it's a self-contained copy rather than a shared import.
//
// Two questions, reported separately, because conflating them is how a pinned project reads as
// permanently stale: (1) do the compiled skills match what this project is synced to, and (2) has the
// Binder published a newer version than the one pinned. A pinned project that answers yes to (2) is not
// broken — it is pinned, which is what was asked for.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readConfig, parsePinComment, parseLiveComment, GUID_PATTERN } from './compile-binder.mjs';

function parseArgs(argv) {
  const args = { dir: '.github/skills', apiBase: null, token: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--api-base') args.apiBase = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
  }
  if (!args.token) args.token = process.env.BINDRY_API_TOKEN ?? null;
  return args;
}

function findCompiledSkills(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    if (existsSync(skillPath)) found.push({ skillDir: entry.name, skillPath });
  }
  return found;
}

async function request(url, token) {
  const headers = {};
  if (token) headers['X-Api-Key'] = token;
  try {
    return await fetch(url, { headers });
  } catch (err) {
    fail(`could not reach ${url} (${err.message}). Is the Bindry API running and reachable?`);
  }
}

async function readJson(response, url) {
  try {
    return await response.json();
  } catch (err) {
    fail(`response from ${url} was not valid JSON (${err.message}).`);
  }
}

/**
 * What the Binder says its Skills should be pinned at, plus the version context around it:
 * { versionBySkillId, pinnedVersion, currentVersion, source }.
 *
 * Resolved "yours first, then the Library", the same order compile-binder.mjs uses — a key scoped to
 * your own workspace must never stop you checking a Binder you installed from the Library. A pinned
 * project goes straight to the Library route: the workspace route only ever serves the Binder's current
 * composition, so asking it about a pinned version could only produce a confidently wrong answer.
 */
async function fetchBinderState(binderId, apiBase, token, version) {
  const base = apiBase.replace(/\/$/, '');

  if (token && GUID_PATTERN.test(binderId) && !version) {
    const url = `${base}/api/binders/${binderId}`;
    const response = await request(url, token);
    if (response.ok) {
      const detail = await readJson(response, url);
      return {
        versionBySkillId: new Map((detail.skills ?? []).map((b) => [b.skillId, b.pinnedVersion])),
        pinnedVersion: null,
        currentVersion: detail.binder?.currentVersion ?? '',
        slug: detail.binder?.slug ?? '',
        source: 'your workspace'
      };
    }
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
      fail(`drift check failed: ${response.status} ${response.statusText} (${url})`);
    }
    // Falls through to the Library route below.
  }

  const pin = version ? `&version=${encodeURIComponent(version)}` : '';
  const url = `${base}/api/public/catalog/binders/${encodeURIComponent(binderId)}/export?target=SkillBundle${pin}`;
  const response = await request(url, null);

  if (response.status === 400 && version) {
    const detail = await readProblemDetail(response);
    fail(
      detail
        ? `${detail} (bindry.config.json pins version ${version})`
        : `version ${version} of Binder "${binderId}" could not be read (${response.status} from ${url}).`
    );
  }
  if (response.status === 404) {
    fail(
      `Binder "${binderId}" was not found at ${apiBase} — it may have been archived or unpublished. ` +
      `If it is your own private Binder, pass --token <api-key> (or set BINDRY_API_TOKEN).`
    );
  }
  if (!response.ok) {
    fail(`drift check failed: ${response.status} ${response.statusText} (${url})`);
  }

  const envelope = await readJson(response, url);
  let bundle;
  try {
    bundle = JSON.parse(envelope.content ?? '');
  } catch (err) {
    fail(`the SkillBundle export from ${url} was not valid JSON (${err.message}).`);
  }

  return {
    versionBySkillId: new Map((bundle.skills ?? []).map((b) => [b.id, b.version])),
    pinnedVersion: envelope.version || null,
    currentVersion: envelope.currentVersion ?? '',
    slug: bundle.slug ?? '',
    source: envelope.version ? `the Library, pinned to ${envelope.version}` : 'the Library'
  };
}

async function readProblemDetail(response) {
  try {
    const problem = await response.json();
    const fieldErrors = Object.values(problem?.errors ?? {}).flat().filter(Boolean);
    if (fieldErrors.length > 0) return fieldErrors.join(' ');
    return problem?.detail || problem?.title || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const apiBase = args.apiBase ?? config?.apiBase;
  const binderId = config?.binderId;
  const requestedVersion = args.version?.trim();
  const version = requestedVersion === 'latest' ? null : (requestedVersion || config?.version || null);

  if (!binderId) {
    fail('no Binder id known — use the bindry-sync skill at least once first, so bindry.config.json remembers which Binder this project is synced to.');
  }
  if (!apiBase) {
    fail('--api-base is required (or use the bindry-sync skill at least once so bindry.config.json remembers it).');
  }

  const skillsDir = resolve(process.cwd(), args.dir);
  const skills = findCompiledSkills(skillsDir);
  // A Binder made entirely of path-shaped skills compiles to no SKILL.md at all on Copilot (BIND-0262),
  // so "no skills" is only "nothing to check" when there are no instruction files either (BIND-0267).
  const instructionFiles = readInstructionFiles(process.cwd());
  if (skills.length === 0 && instructionFiles.length === 0) {
    console.log(`bindry: no compiled skills found in ${skillsDir}. Use the bindry-sync skill first.`);
    return;
  }

  const state = await fetchBinderState(binderId, apiBase, args.token, version);
  const currentBySkillId = state.versionBySkillId;

  let staleCount = 0;
  let unknownCount = 0;
  let liveCount = 0;

  for (const { skillDir, skillPath } of skills) {
    const contents = readFileSync(skillPath, 'utf8');
    const pin = parsePinComment(contents);

    if (pin) {
      const expected = currentBySkillId.get(pin.skill);
      if (expected === undefined) {
        console.log(`  ? ${skillDir} — its Skill is no longer part of Binder ${pin.binder} (removed, or this project is synced to a different Binder now)`);
        unknownCount++;
      } else if (expected === pin.version) {
        console.log(`  = ${skillDir} — up to date (${pin.version})`);
      } else if (state.pinnedVersion) {
        console.log(`  ! ${skillDir} — stale against pinned ${state.pinnedVersion}: compiled at ${pin.version}, that version pins ${expected}`);
        staleCount++;
      } else {
        console.log(`  ! ${skillDir} — stale: compiled at ${pin.version}, Binder now pins ${expected}`);
        staleCount++;
      }
      continue;
    }

    const live = parseLiveComment(contents);
    if (live) {
      if (!currentBySkillId.has(live.skill)) {
        console.log(`  ? ${skillDir} — its Skill is no longer part of Binder ${live.binder} (removed, or this project is synced to a different Binder now)`);
        unknownCount++;
      } else {
        console.log(`  ~ ${skillDir} — live (always current, calls the MCP server directly)`);
        liveCount++;
      }
      continue;
    }

    console.log(`  ? ${skillDir} — no bindry:pin or bindry:live comment found, can't check (not compiled by bindry-sync?)`);
    unknownCount++;
  }

  const upToDateCount = skills.length - staleCount - unknownCount - liveCount;
  console.log('');
  if (skills.length === 0) {
    // Only instruction files were found; they have their own section below.
  } else if (staleCount === 0 && unknownCount === 0 && liveCount === 0) {
    console.log(
      state.pinnedVersion
        ? `bindry: all ${skills.length} skill(s) match pinned version ${state.pinnedVersion}.`
        : `bindry: all ${skills.length} skill(s) are up to date.`
    );
  } else {
    console.log(`bindry: ${upToDateCount} up to date, ${staleCount} stale, ${liveCount} live, ${unknownCount} unknown, out of ${skills.length} skill(s).`);
    if (staleCount > 0) console.log('bindry: use the bindry-sync skill to update the stale skill(s).');
  }

  // Being behind the newest published version is a separate fact from being stale, and it is not a
  // problem: a pinned project is deliberately not following the Binder. Said once, at the end, so a
  // pinned project does not read as broken on every line.
  if (state.pinnedVersion && state.currentVersion && state.currentVersion !== state.pinnedVersion) {
    console.log(
      `bindry: pinned to ${state.pinnedVersion}; the Binder has since published ${state.currentVersion}. ` +
      `Nothing is stale — use the bindry-sync skill with --version ${state.currentVersion} (or --version latest) when you want to move.`
    );
  } else if (state.pinnedVersion) {
    console.log(`bindry: pinned to ${state.pinnedVersion}, which is the newest published version.`);
  }

  reportInstructionFiles(instructionFiles, currentBySkillId, state);
  reportAlwaysOnBlocks(process.cwd(), state.slug, state.currentVersion);
}


// --- Path-matched instruction files (BIND-0267) ------------------------------------------------
//
// On Copilot a skill with `appliesToPaths` compiles to `.github/instructions/<slug>.instructions.md`
// at the repo root INSTEAD OF a SKILL.md (BIND-0245). The skill scan above looks for
// `<dir>/<subdir>/SKILL.md`, so it never sees one: wrong location and wrong filename. Until this, a
// path-shaped skill was the one compiled output that could fall behind forever without anything saying so.
//
// They are not missing a marker. They carry `<!-- bindry:instructions skill=<id> version=<v> -->`,
// which is the same two facts a SKILL.md pin holds, and the SkillBundle export this script already reads
// lists EVERY skill of the Binder with its pinned version whatever its shape. So the comparison is the
// ordinary one; only the finding was missing.
//
// DECIDED: only files that EXIST are reported. A path-shaped skill whose file was deleted is not
// flagged, for the same reason a deleted SKILL.md is not: the export carries no `appliesToPaths`, so
// nothing here can say which files SHOULD exist. Guessing would report a skill that was never
// path-shaped as missing.
//
// DECIDED: a skill that is no longer path-shaped leaves its old file behind (a sync writes files, it
// does not remove them). Its version has moved on, so it reads as stale, and the advice says so rather
// than suggesting a sync that cannot clear it. It is NOT detected by "a SKILL.md for this skill exists
// too": on Claude Code every skill has a SKILL.md, path-shaped or not, and a repo with more than one
// plugin legitimately holds both files for one skill.
//
// The marker carries no Binder slug, so a file whose skill is not in THIS Binder is named and not
// judged, exactly as another Binder's always-on block is: it may be a healthy second Binder.
const INSTRUCTIONS_DIR = '.github/instructions';
const INSTRUCTIONS_MARKER = /<!--\s*bindry:instructions\s+skill=(\S+)\s+version=(\S+)\s*-->/;

/** Every Bindry-written instruction file under .github/instructions, as { file, skill, version }. */
export function readInstructionFiles(root) {
  const dir = join(root, INSTRUCTIONS_DIR);
  if (!existsSync(dir)) return [];

  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.instructions.md')) continue;
    const match = INSTRUCTIONS_MARKER.exec(readFileSync(join(dir, entry.name), 'utf8'));
    // No marker: written by hand, or by something else. Not ours to report on.
    if (!match) continue;
    found.push({ file: `${INSTRUCTIONS_DIR}/${entry.name}`, skill: match[1], version: match[2] });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** 'current', 'stale' (with what the Binder now pins), or 'elsewhere' when the skill is not in this Binder. */
export function judgeInstructionFile(file, currentBySkillId) {
  const expected = currentBySkillId.get(file.skill);
  if (expected === undefined) return { status: 'elsewhere', expected: null };
  return expected === file.version
    ? { status: 'current', expected }
    : { status: 'stale', expected };
}

function reportInstructionFiles(files, currentBySkillId, state) {
  if (files.length === 0) return;

  console.log('');
  console.log('bindry: path-matched instruction files (applied by file path, not chosen by the agent)');

  let staleCount = 0;
  for (const file of files) {
    const { status, expected } = judgeInstructionFile(file, currentBySkillId);
    if (status === 'current') {
      console.log(`  = ${file.file} — up to date (${file.version})`);
    } else if (status === 'stale') {
      staleCount++;
      console.log(
        state.pinnedVersion
          ? `  ! ${file.file} — stale against pinned ${state.pinnedVersion}: compiled at ${file.version}, that version pins ${expected}`
          : `  ! ${file.file} — stale: compiled at ${file.version}, Binder now pins ${expected}`
      );
    } else {
      console.log(`  · ${file.file} — its skill is not in this Binder, so it is not checked here (another Binder's, or removed)`);
    }
  }

  if (staleCount > 0) {
    console.log('bindry: use the bindry-sync skill to update the stale instruction file(s). A skill that is no longer matched by path leaves its old file behind; delete that one.');
  }
}


// --- Always-on blocks (BIND-0243) --------------------------------------------------------------
//
// Skills live one-per-directory, so they never collide. The always-on block does: every Binder
// installed into a repo keeps its block in the SAME file, and nothing anywhere tracks the full set.
// That is what makes them worth reporting — a block acts on every single turn, and until now the
// only way to know what was in there was to open the file and read it.
//
// All three candidate files are scanned rather than just this plugin's own. A repo with more than
// one plugin installed genuinely has more than one, and showing only ours would under-report what
// is actually acting on the agent.
const ALWAYS_ON_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];

const PREAMBLE_MARKER = /<!--\s*bindry:preamble\s+binder=([a-z0-9-]+)(?:\s+version=(\S+))?\s*-->/g;

export function readAlwaysOnBlocks(root) {
  const found = [];
  for (const relative of ALWAYS_ON_FILES) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;

    const contents = readFileSync(path, 'utf8');
    for (const match of contents.matchAll(PREAMBLE_MARKER)) {
      found.push({ file: relative, slug: match[1], version: match[2] ?? '' });
    }
  }
  return found;
}

/**
 * Reports the always-on blocks in this repo.
 *
 * Deliberately does NOT call another Binder's block orphaned. This script knows about exactly one
 * Binder — the one in bindry.config.json — so a block belonging to a different slug may be a
 * perfectly healthy second Binder or may be left over from one that was removed, and nothing here
 * can tell the difference. Reporting it as a problem would be a guess dressed up as a finding.
 */
function reportAlwaysOnBlocks(root, slug, currentVersion) {
  const blocks = readAlwaysOnBlocks(root);
  if (blocks.length === 0) return;

  console.log('');
  console.log('bindry: always-on instructions (loaded on every turn, not only when a skill matches)');

  for (const block of blocks) {
    const label = `${block.file} — ${block.slug}${block.version ? ` (${block.version})` : ''}`;
    if (slug && block.slug === slug) {
      if (currentVersion && block.version && block.version !== currentVersion) {
        console.log(`  ! ${label} — stale: the Binder now publishes ${currentVersion}`);
      } else {
        console.log(`  = ${label} — current`);
      }
    } else {
      // Named, not judged: this is another Binder's block and this script cannot see its state.
      console.log(`  · ${label} — from another Binder, not checked here`);
    }
  }
}

// Only run when executed directly, matching compile-binder.mjs — so the helpers above can be
// imported and tested without a full drift check firing as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
