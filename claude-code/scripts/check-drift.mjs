#!/usr/bin/env node
// Reports which compiled skills are stale against their Stack's current pinned Binding
// versions. Read-only — never re-syncs or writes anything.
//
// Usage:
//   node check-drift.mjs [--dir <skills-dir>] [--api-base <url>] [--token <api-key>] [--version <v>]
//
// Reuses bindry.config.json (written by compile-stack.mjs) for the Stack id, API base and pinned
// version unless overridden with flags, so a plain `/bindry-check` works right after a `/bindry-sync`.
//
// Two questions, reported separately, because conflating them is how a pinned project reads as
// permanently stale: (1) do the compiled skills match what this project is synced to, and (2) has the
// Stack published a newer version than the one pinned. A pinned project that answers yes to (2) is not
// broken — it is pinned, which is what was asked for.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fail, readConfig, parsePinComment, parseLiveComment, GUID_PATTERN } from './compile-stack.mjs';

function parseArgs(argv) {
  const args = { dir: '.claude/skills', apiBase: null, token: null, version: null };
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
 * What the Stack says its Bindings should be pinned at, plus the version context around it:
 * { versionByBindingId, pinnedVersion, currentVersion, source }.
 *
 * Resolved "yours first, then the Library", the same order compile-stack.mjs uses — a key scoped to
 * your own workspace must never stop you checking a Stack you installed from the Library. A pinned
 * project goes straight to the Library route: the workspace route only ever serves the Stack's current
 * composition, so asking it about a pinned version could only produce a confidently wrong answer.
 */
async function fetchStackState(stackId, apiBase, token, version) {
  const base = apiBase.replace(/\/$/, '');

  if (token && GUID_PATTERN.test(stackId) && !version) {
    const url = `${base}/api/stacks/${stackId}`;
    const response = await request(url, token);
    if (response.ok) {
      const detail = await readJson(response, url);
      return {
        versionByBindingId: new Map((detail.bindings ?? []).map((b) => [b.bindingId, b.pinnedVersion])),
        pinnedVersion: null,
        currentVersion: detail.stack?.currentVersion ?? '',
        source: 'your workspace'
      };
    }
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
      fail(`drift check failed: ${response.status} ${response.statusText} (${url})`);
    }
    // Falls through to the Library route below.
  }

  const pin = version ? `&version=${encodeURIComponent(version)}` : '';
  const url = `${base}/api/public/catalog/stacks/${encodeURIComponent(stackId)}/export?target=SkillBundle${pin}`;
  const response = await request(url, null);

  if (response.status === 400 && version) {
    const detail = await readProblemDetail(response);
    fail(
      detail
        ? `${detail} (bindry.config.json pins version ${version})`
        : `version ${version} of Stack "${stackId}" could not be read (${response.status} from ${url}).`
    );
  }
  if (response.status === 404) {
    fail(
      `Stack "${stackId}" was not found at ${apiBase} — it may have been archived or unpublished. ` +
      `If it is your own private Stack, pass --token <api-key> (or set BINDRY_API_TOKEN).`
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
    versionByBindingId: new Map((bundle.bindings ?? []).map((b) => [b.id, b.version])),
    pinnedVersion: envelope.version || null,
    currentVersion: envelope.currentVersion ?? '',
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
  const stackId = config?.stackId;
  const requestedVersion = args.version?.trim();
  const version = requestedVersion === 'latest' ? null : (requestedVersion || config?.version || null);

  if (!stackId) {
    fail('no Stack id known — run /bindry-sync at least once first, so bindry.config.json remembers which Stack this project is synced to.');
  }
  if (!apiBase) {
    fail('--api-base is required (or run /bindry-sync at least once so bindry.config.json remembers it).');
  }

  const skillsDir = resolve(process.cwd(), args.dir);
  const skills = findCompiledSkills(skillsDir);
  if (skills.length === 0) {
    console.log(`bindry: no compiled skills found in ${skillsDir}. Run /bindry-sync first.`);
    return;
  }

  const state = await fetchStackState(stackId, apiBase, args.token, version);
  const currentByBindingId = state.versionByBindingId;

  let staleCount = 0;
  let unknownCount = 0;
  let liveCount = 0;

  for (const { skillDir, skillPath } of skills) {
    const contents = readFileSync(skillPath, 'utf8');
    const pin = parsePinComment(contents);

    if (pin) {
      const expected = currentByBindingId.get(pin.binding);
      if (expected === undefined) {
        console.log(`  ? ${skillDir} — its Binding is no longer part of Stack ${pin.stack} (removed, or this project is synced to a different Stack now)`);
        unknownCount++;
      } else if (expected === pin.version) {
        console.log(`  = ${skillDir} — up to date (${pin.version})`);
      } else if (state.pinnedVersion) {
        console.log(`  ! ${skillDir} — stale against pinned ${state.pinnedVersion}: compiled at ${pin.version}, that version pins ${expected}`);
        staleCount++;
      } else {
        console.log(`  ! ${skillDir} — stale: compiled at ${pin.version}, Stack now pins ${expected}`);
        staleCount++;
      }
      continue;
    }

    const live = parseLiveComment(contents);
    if (live) {
      if (!currentByBindingId.has(live.binding)) {
        console.log(`  ? ${skillDir} — its Binding is no longer part of Stack ${live.stack} (removed, or this project is synced to a different Stack now)`);
        unknownCount++;
      } else {
        console.log(`  ~ ${skillDir} — live (always current, calls the MCP server directly)`);
        liveCount++;
      }
      continue;
    }

    console.log(`  ? ${skillDir} — no bindry:pin or bindry:live comment found, can't check (not compiled by /bindry-sync?)`);
    unknownCount++;
  }

  const upToDateCount = skills.length - staleCount - unknownCount - liveCount;
  console.log('');
  if (staleCount === 0 && unknownCount === 0 && liveCount === 0) {
    console.log(
      state.pinnedVersion
        ? `bindry: all ${skills.length} skill(s) match pinned version ${state.pinnedVersion}.`
        : `bindry: all ${skills.length} skill(s) are up to date.`
    );
  } else {
    console.log(`bindry: ${upToDateCount} up to date, ${staleCount} stale, ${liveCount} live, ${unknownCount} unknown, out of ${skills.length} skill(s).`);
    if (staleCount > 0) console.log('bindry: run /bindry-sync to update the stale skill(s).');
  }

  // Being behind the newest published version is a separate fact from being stale, and it is not a
  // problem: a pinned project is deliberately not following the Stack. Said once, at the end, so a
  // pinned project does not read as broken on every line.
  if (state.pinnedVersion && state.currentVersion && state.currentVersion !== state.pinnedVersion) {
    console.log(
      `bindry: pinned to ${state.pinnedVersion}; the Stack has since published ${state.currentVersion}. ` +
      `Nothing is stale — run /bindry-sync --version ${state.currentVersion} (or --version latest) when you want to move.`
    );
  } else if (state.pinnedVersion) {
    console.log(`bindry: pinned to ${state.pinnedVersion}, which is the newest published version.`);
  }
}

main();
