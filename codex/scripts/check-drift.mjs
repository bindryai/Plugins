#!/usr/bin/env node
// Reports which compiled skills are stale against their Stack's current pinned Binding
// versions. Read-only — never re-syncs or writes anything.
//
// Usage:
//   node check-drift.mjs [--dir <skills-dir>] [--api-base <url>] [--token <api-key>]
//
// Reuses bindry.config.json (written by compile-stack.mjs) for the Stack id and API base
// unless overridden with flags, so running this right after a sync needs no arguments.
//
// This is Codex's copy of the same checker that ships with the Claude Code plugin
// (../../claude-code/scripts/check-drift.mjs) — see compile-stack.mjs in this directory for why
// it's a self-contained copy rather than a shared import.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fail, readConfig, parsePinComment, parseLiveComment } from './compile-stack.mjs';

function parseArgs(argv) {
  const args = { dir: '.agents/skills', apiBase: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--api-base') args.apiBase = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
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

async function fetchStackDetail(stackId, apiBase, token) {
  const url = `${apiBase.replace(/\/$/, '')}/api/stacks/${stackId}`;
  const headers = {};
  if (token) headers['X-Api-Key'] = token;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    fail(`could not reach ${apiBase} (${err.message}). Is the Bindry API running and reachable?`);
  }

  if (response.status === 401 || response.status === 403) {
    fail(
      `authentication failed (${response.status}) fetching ${url}. ` +
      `Pass --token <api-key> (generate one from Bindry → Account settings → API keys), ` +
      `or set the BINDRY_API_TOKEN environment variable.`
    );
  }
  if (response.status === 404) {
    fail(`Stack ${stackId} was not found at ${apiBase} — it may have been archived.`);
  }
  if (!response.ok) {
    fail(`drift check failed: ${response.status} ${response.statusText} (${url})`);
  }

  try {
    return await response.json();
  } catch (err) {
    fail(`response from ${url} was not valid JSON (${err.message}).`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const apiBase = args.apiBase ?? config?.apiBase;
  const stackId = config?.stackId;

  if (!stackId) {
    fail('no Stack id known — use the bindry-sync skill at least once first, so bindry.config.json remembers which Stack this project is synced to.');
  }
  if (!apiBase) {
    fail('--api-base is required (or use the bindry-sync skill at least once so bindry.config.json remembers it).');
  }

  const skillsDir = resolve(process.cwd(), args.dir);
  const skills = findCompiledSkills(skillsDir);
  if (skills.length === 0) {
    console.log(`bindry: no compiled skills found in ${skillsDir}. Use the bindry-sync skill first.`);
    return;
  }

  const detail = await fetchStackDetail(stackId, apiBase, args.token);
  const currentByBindingId = new Map((detail.bindings ?? []).map((b) => [b.bindingId, b]));

  let staleCount = 0;
  let unknownCount = 0;
  let liveCount = 0;

  for (const { skillDir, skillPath } of skills) {
    const contents = readFileSync(skillPath, 'utf8');
    const pin = parsePinComment(contents);

    if (pin) {
      const current = currentByBindingId.get(pin.binding);
      if (!current) {
        console.log(`  ? ${skillDir} — its Binding is no longer part of Stack ${pin.stack} (removed, or this project is synced to a different Stack now)`);
        unknownCount++;
      } else if (current.pinnedVersion === pin.version) {
        console.log(`  = ${skillDir} — up to date (${pin.version})`);
      } else {
        console.log(`  ! ${skillDir} — stale: compiled at ${pin.version}, Stack now pins ${current.pinnedVersion}`);
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

    console.log(`  ? ${skillDir} — no bindry:pin or bindry:live comment found, can't check (not compiled by bindry-sync?)`);
    unknownCount++;
  }

  const upToDateCount = skills.length - staleCount - unknownCount - liveCount;
  console.log('');
  if (staleCount === 0 && unknownCount === 0 && liveCount === 0) {
    console.log(`bindry: all ${skills.length} skill(s) are up to date.`);
  } else {
    console.log(`bindry: ${upToDateCount} up to date, ${staleCount} stale, ${liveCount} live, ${unknownCount} unknown, out of ${skills.length} skill(s).`);
    if (staleCount > 0) console.log('bindry: use the bindry-sync skill to update the stale skill(s).');
  }
}

main();
