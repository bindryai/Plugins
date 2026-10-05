#!/usr/bin/env node
// Compiles a Bindry Binder export into one Codex skill per Skill.
// Reads the export from a local file, a full export URL, a Binder GUID *or Library slug*
// (fetched live from --api-base), or — if no source is given — whatever was last synced,
// remembered in ./bindry.config.json.
//
// Usage:
//   node compile-binder.mjs <binder-export.json> [--out <dir>]
//   node compile-binder.mjs <binder-id-or-slug> --api-base <url> [--token <api-key>] [--out <dir>] [--mode pinned|live]
//   node compile-binder.mjs <binder-slug> --api-base <url> --version 1.2.0   (pin to a published version)
//   node compile-binder.mjs --api-base <url> [--token <api-key>]   (reuses bindry.config.json, incl. --mode and --version)
//
// Two kinds of Binder resolve here. Your own (workspace-scoped, may be private) needs --token and comes
// from /api/binders/{guid}/export/file. Someone else's published Binder needs no token at all and comes
// from /api/public/catalog/binders/{slug-or-guid}/export/file — that public route is what makes installing
// a Binder from the Library possible without owning the workspace that wrote it. A token is tried
// first when present, then the public route: a key scoped to your own workspace must not stop you
// installing a public Binder.
//
// --version <v> pins this project to a published version of a Library Binder, so later syncs keep
// compiling that version's recorded content even after the publisher ships a newer one. The version is
// remembered in bindry.config.json and honoured by a bare re-sync; --version latest removes the pin.
// Pinning only applies to the public Library route: your own workspace Binder always compiles from its
// current composition, which is the point of editing it.
//
// --mode live compiles a pointer skill per Skill that calls the Bindry MCP tools for current
// content at run time, instead of embedding a snapshot. Requires the Bindry MCP server to be
// connected separately — see skills/bindry-connect/SKILL.md. Default is --mode pinned (unchanged
// snapshot behavior); the mode is remembered in bindry.config.json like the Binder id and API base.
//
// This is Codex's copy of the same compiler that ships with the Claude Code plugin
// (../../claude-code/scripts/compile-binder.mjs) — identical logic, since both platforms use the
// same SKILL.md format. Kept as a self-contained copy rather than a shared import: installed
// plugins live at independent, versioned cache paths per platform with no guaranteed shared
// filesystem layout, so each plugin bundles its own scripts. The only behavioral difference is
// the default output directory below (Codex's project-local skills live in .agents/skills, not
// .claude/skills).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'bindry.config.json';
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `binder-version=` is optional and comes last, so every pin written before BIND-0252 still parses.
// Accepted even though this script never writes it: `bindry pull --binder-version` does, and this
// parser is what bindry-check reads back. See BIND-0259 — the format lives in four places and they
// have to agree, or a folder of real compiled skills reports as not compiled by Bindry.
const PIN_PATTERN =
  /<!--\s*bindry:pin\s+binder=(\S+)\s+skill=(\S+)\s+version=(\S+?)(?:\s+binder-version=(\S+))?\s*-->/;
const LIVE_PATTERN = /<!--\s*bindry:live\s+binder=(\S+)\s+skill=(\S+)\s*-->/;

// Shared with check-drift.mjs, which parses this same line back out of a compiled SKILL.md
// rather than re-implementing the pin format.
export function renderPinComment(binder, skill) {
  return `<!-- bindry:pin binder=${binder.slug} skill=${skill.id} version=${skill.version} -->`;
}

export function parsePinComment(contents) {
  const match = PIN_PATTERN.exec(contents);
  return match
    ? { binder: match[1], skill: match[2], version: match[3], binderVersion: match[4] ?? null }
    : null;
}

// A live-compiled skill has no version to pin — it always calls the MCP server for current
// content — so it carries this sibling marker instead. Kept separate from renderPinComment
// rather than merged so the already-tested pinned-mode format/output stays untouched.
export function renderLiveComment(binder, skill) {
  return `<!-- bindry:live binder=${binder.slug} skill=${skill.id} -->`;
}

export function parseLiveComment(contents) {
  const match = LIVE_PATTERN.exec(contents);
  return match ? { binder: match[1], skill: match[2] } : null;
}

/**
 * Which version this run should compile: the flag when given, otherwise whatever bindry.config.json
 * remembers, otherwise none.
 *
 * `--version latest` is how a pin is removed — an explicit word, because deleting the line from
 * bindry.config.json by hand is the kind of thing that gets done to one checkout and not the others,
 * and a pin that is still in half the team's configs is worse than no pin at all.
 */
export function resolvePinnedVersion(flag, remembered) {
  const requested = flag?.trim();
  if (requested === 'latest') return null;
  return requested || remembered || null;
}

export function parseArgs(argv) {
  const args = { input: null, out: '.agents/skills', apiBase: null, token: null, target: 'SkillBundle', mode: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--api-base') args.apiBase = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (!args.input) args.input = argv[i];
  }
  if (!args.token) args.token = process.env.BINDRY_API_TOKEN ?? null;
  return args;
}

export function fail(message) {
  console.error(`bindry: ${message}`);
  process.exit(1);
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The description is loaded for EVERY skill in a Binder on every turn, so it is the one piece of
// output with an unavoidable per-turn cost. The cap bounds what we ADD and never shortens the
// title or the "Use when" clause, so a skill with no exclusions renders exactly what it rendered
// before this existed.
const MAX_DESCRIPTION_LENGTH = 500;

const formatExclusions = (exclusions) => ` Not for: ${exclusions.join('; ')}.`;

// Exclusions belong in the description, not only in the body: every host loads name and
// description for all skills, then loads the body only once a skill has been chosen. A
// "does not apply when" that lives solely in the body cannot prevent a wrong selection — it can
// only persuade the model to back out after it has already paid to load the file.
//
// Exclusions are dropped as whole clauses, never cut mid-phrase: half a condition reads as a
// different condition, and a rule that quietly means something else is worse than one that is absent.
function describeSkill(skill) {
  const trigger = skill.appliesWhen?.length
    ? skill.appliesWhen.join('; ')
    : skill.title;
  const head = `${skill.title}. Use when: ${trigger}.`;

  const exclusions = skill.doesNotApplyWhen ?? [];
  if (exclusions.length === 0) return head;

  // Author order is deliberate: the first one listed is the one they thought of first.
  const kept = [];
  for (const exclusion of exclusions) {
    if (head.length + formatExclusions([...kept, exclusion]).length > MAX_DESCRIPTION_LENGTH) break;
    kept.push(exclusion);
  }

  return kept.length === 0 ? head : head + formatExclusions(kept);
}

function renderSkill(binder, skill, assets, mode) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${slugify(skill.slug ?? skill.title)}`);
  lines.push(`description: ${describeSkill(skill).replace(/"/g, "'")}`);
  lines.push('---');
  lines.push('');

  if (mode === 'live') {
    lines.push(renderLiveComment(binder, skill));
    lines.push('');
    lines.push(
      'This skill is compiled in **live** mode — its instructions are not stored locally. Before proceeding, ' +
      `call the \`bindry.skills.get\` MCP tool with \`{"skillId": "${skill.id}"}\` and follow the ` +
      '`instructions`, `constraints`, and `verificationChecklist` it returns. Treat this file as a pointer only.'
    );
    lines.push('');
    lines.push(
      'If the tool call fails (not connected, network, auth/scope error), say so plainly and stop — do not ' +
      'guess. If the Bindry MCP server isn\'t connected yet, use the `bindry-connect` skill first.'
    );
  } else {
    lines.push(renderPinComment(binder, skill));
    lines.push('');
    lines.push(skill.instructions.trim());

    if (skill.doesNotApplyWhen?.length) {
      lines.push('');
      lines.push('Does not apply when:');
      for (const item of skill.doesNotApplyWhen) lines.push(`- ${item}`);
    }

    if (skill.constraints?.length) {
      lines.push('');
      lines.push('Constraints:');
      for (const item of skill.constraints) lines.push(`- ${item}`);
    }

    if (skill.verification?.length) {
      lines.push('');
      lines.push('Verify before finishing:');
      for (const item of skill.verification) lines.push(`- ${item}`);
    }
  }

  if (assets?.length) {
    lines.push('');
    lines.push('Assets:');
    for (const asset of assets) {
      lines.push(
        asset.contentType?.startsWith('image/')
          ? `- ![${asset.fileName}](assets/${asset.fileName})`
          : `- [${asset.fileName}](assets/${asset.fileName})`
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function resolveAssetUrl(url, apiBase) {
  if (/^(https?|data):/i.test(url)) return url;
  if (!apiBase) return null;
  return `${apiBase.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}

async function downloadAssets(skill, skillDir, args) {
  const attachments = skill.attachments ?? [];
  if (attachments.length === 0) return [];

  const downloaded = [];

  for (const attachment of attachments) {
    if (!attachment.fileName || !attachment.url) {
      console.warn(`bindry: skipping an attachment on "${skill.title}" missing "fileName" or "url".`);
      continue;
    }

    const fileName = basename(attachment.fileName);
    const assetUrl = resolveAssetUrl(attachment.url, args.apiBase);
    if (!assetUrl) {
      console.warn(
        `bindry: skipping asset "${fileName}" on "${skill.title}" — its URL (${attachment.url}) is relative ` +
        `and no --api-base was given to resolve it against.`
      );
      continue;
    }

    const headers = {};
    if (args.token && !/^data:/i.test(assetUrl)) headers['X-Api-Key'] = args.token;

    let response;
    try {
      response = await fetch(assetUrl, { headers });
    } catch (err) {
      console.warn(`bindry: skipping asset "${fileName}" on "${skill.title}" — could not reach ${assetUrl} (${err.message}).`);
      continue;
    }

    if (!response.ok) {
      console.warn(`bindry: skipping asset "${fileName}" on "${skill.title}" — ${assetUrl} responded ${response.status} ${response.statusText}.`);
      continue;
    }

    const assetsDir = join(skillDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(assetsDir, fileName), bytes);
    downloaded.push({ fileName, contentType: attachment.contentType });
  }

  return downloaded;
}

export function readConfig() {
  const configPath = resolve(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  const configPath = resolve(process.cwd(), CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return configPath;
}

function workspaceExportUrl(apiBase, binderId, target) {
  return `${apiBase.replace(/\/$/, '')}/api/binders/${binderId}/export/file?target=${encodeURIComponent(target)}`;
}

export function publicExportUrl(apiBase, slugOrId, target, version) {
  const base = apiBase.replace(/\/$/, '');
  const pin = version ? `&version=${encodeURIComponent(version)}` : '';
  return `${base}/api/public/catalog/binders/${encodeURIComponent(slugOrId)}/export/file?target=${encodeURIComponent(target)}${pin}`;
}

// The version-pinned route answers a bad version with ProblemDetails naming the versions that do
// exist. Without reading that body, "please pin 2.8" fails as a bare "400 Bad Request" and the one
// piece of information the user needs — which versions they could have asked for — is thrown away.
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

async function requestExport(url, token) {
  try {
    return await fetch(url, token ? { headers: { 'X-Api-Key': token } } : {});
  } catch (err) {
    fail(`could not reach ${url} (${err.message}). Is the Bindry API running and reachable?`);
  }
}

async function readExportJson(response, url) {
  try {
    return await response.json();
  } catch (err) {
    fail(`response from ${url} was not valid JSON (${err.message}). Is --target set to a JSON-producing target?`);
  }
}

// Resolves a Binder by GUID or Library slug. The workspace route is only attempted for a GUID with a
// token — it cannot serve a slug, and without a token it can only ever 401. Anything it declines
// (401/403/404) falls through to the public Library, so "I have a key for my own workspace" never becomes
// "I can't install a public Binder".
async function fetchLive(slugOrId, apiBase, token, target, version) {
  const isGuid = GUID_PATTERN.test(slugOrId);
  let workspaceStatus = null;

  // A pinned sync skips the workspace route on purpose: /api/binders/{id}/export always compiles the
  // Binder's current composition and has no version to serve, so trying it first would quietly hand a
  // pinned project the live content under a version number it never published.
  if (token && isGuid && !version) {
    const url = workspaceExportUrl(apiBase, slugOrId, target);
    const response = await requestExport(url, token);
    if (response.ok) return readExportJson(response, url);
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
      fail(`export request failed: ${response.status} ${response.statusText} (${url})`);
    }
    workspaceStatus = response.status;
  }

  const publicUrl = publicExportUrl(apiBase, slugOrId, target, version);
  const publicResponse = await requestExport(publicUrl, null);
  if (publicResponse.ok) return readExportJson(publicResponse, publicUrl);

  if (version && publicResponse.status === 400) {
    const detail = await readProblemDetail(publicResponse);
    fail(
      detail
        ? `${detail} (asked for version ${version} of "${slugOrId}")`
        : `version ${version} of Binder "${slugOrId}" could not be exported (${publicResponse.status} from ${publicUrl}).`
    );
  }

  if (publicResponse.status === 404) {
    if (workspaceStatus === 401 || workspaceStatus === 403) {
      fail(
        `authentication failed (${workspaceStatus}) for Binder ${slugOrId} in your workspace, and it is not ` +
        `published to the public Library either. Check --token (generate one from the workspace's Team page ` +
        `in Bindry), or set BINDRY_API_TOKEN.`
      );
    }
    fail(
      token || !isGuid
        ? `Binder "${slugOrId}" was not found at ${apiBase}. A public Binder must be Published with Public ` +
          `visibility to be installable; a private one needs --token.`
        : `Binder "${slugOrId}" is not in the public Library at ${apiBase}. If it's your own private Binder, ` +
          `pass --token <api-key> (or set BINDRY_API_TOKEN).`
    );
  }
  if (publicResponse.status === 401 || publicResponse.status === 403) {
    fail(
      `authentication failed (${publicResponse.status}) fetching ${publicUrl}. ` +
      `Pass --token <api-key> (generate one from the workspace's Team page in Bindry), ` +
      `or set the BINDRY_API_TOKEN environment variable. This Binder may be private.`
    );
  }
  fail(`export request failed: ${publicResponse.status} ${publicResponse.statusText} (${publicUrl})`);
}

// A path, not an identifier: has a separator, ends in .json, or names a file that actually exists.
// Anything else is treated as a Binder GUID or Library slug.
export function looksLikeLocalFile(input) {
  return (
    /[\\/]/.test(input) ||
    input.toLowerCase().endsWith('.json') ||
    existsSync(resolve(process.cwd(), input))
  );
}

function loadLocalFile(inputPath) {
  if (!existsSync(inputPath)) {
    fail(`no such file: ${inputPath}`);
  }
  try {
    return JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    fail(`could not parse ${inputPath} as JSON: ${err.message}`);
  }
}

async function resolveBinder(args, mode, version) {
  // Explicit local file path. Deliberately NOT "anything that isn't a GUID" any more: a Library slug
  // like `git-flow-command-center` is a perfectly good Binder identifier, and the old rule would have tried
  // to open it as a file and failed with a confusing "no such file".
  if (args.input && !/^https?:\/\//i.test(args.input) && looksLikeLocalFile(args.input)) {
    return { binder: loadLocalFile(resolve(process.cwd(), args.input)), synced: null };
  }

  // Explicit full export URL.
  if (args.input && /^https?:\/\//i.test(args.input)) {
    const response = await fetch(args.input, args.token ? { headers: { 'X-Api-Key': args.token } } : undefined);
    if (!response.ok) fail(`export request failed: ${response.status} ${response.statusText} (${args.input})`);
    return { binder: await response.json(), synced: null };
  }

  // Bare Binder GUID or Library slug, or no input at all (falls back to the remembered config).
  let binderId = args.input;
  let apiBase = args.apiBase;
  if (version && binderId && GUID_PATTERN.test(binderId) && args.token) {
    console.warn(
      `bindry: --version applies to Library Binders, and ${binderId} is a GUID with a token — looking it up in ` +
      'the public Library rather than your workspace, because a workspace export has no version to serve.'
    );
  }
  if (!binderId) {
    const config = readConfig();
    if (!config?.binderId) {
      fail(
        'no source given and no bindry.config.json found. Usage: node compile-binder.mjs <binder-export.json | binder-id-or-slug> --api-base <url> [--token <api-key>]'
      );
    }
    binderId = config.binderId;
    apiBase = apiBase ?? config.apiBase;
  }
  if (!apiBase) {
    fail('--api-base is required when syncing a Binder id or slug (e.g. --api-base http://localhost:5160).');
  }

  const binder = await fetchLive(binderId, apiBase, args.token, args.target, version);
  // `version` is omitted rather than written as null when unpinned, so an existing bindry.config.json
  // that never had one is left byte-identical by a plain re-sync.
  return { binder, synced: version ? { binderId, apiBase, mode, version } : { binderId, apiBase, mode } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const mode = args.mode ?? config?.mode ?? 'pinned';
  if (mode !== 'pinned' && mode !== 'live') {
    fail(`--mode must be "pinned" or "live", got "${mode}".`);
  }

  const version = resolvePinnedVersion(args.version, config?.version);
  if (version && mode === 'live') {
    fail('--version and --mode live contradict each other: a live skill always fetches current content, so there is nothing to pin.');
  }

  const { binder, synced } = await resolveBinder(args, mode, version);

  if (!binder.slug || !Array.isArray(binder.skills) || binder.skills.length === 0) {
    fail('the resolved Binder export is missing "slug" or a non-empty "skills" array — is this a Bindry Binder export?');
  }

  const outDir = resolve(process.cwd(), args.out);
  const written = [];

  for (const skill of binder.skills) {
    if (!skill.slug || !skill.instructions) {
      console.warn(`bindry: skipping a skill missing "slug" or "instructions" in ${binder.slug}`);
      continue;
    }
    if (mode === 'live' && !GUID_PATTERN.test(skill.id ?? '')) {
      console.warn(
        `bindry: skipping "${skill.title}" in live mode — its id ("${skill.id}") isn't a GUID, so ` +
        `bindry.skills.get would never be able to look it up at agent run-time.`
      );
      continue;
    }
    const skillDir = join(outDir, slugify(skill.slug));
    mkdirSync(skillDir, { recursive: true });
    const assets = await downloadAssets(skill, skillDir, args);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(binder, skill, assets, mode), 'utf8');
    written.push({ title: skill.title, path: skillPath });
  }

  console.log(`bindry: compiled "${binder.title ?? binder.slug}" (${binder.skills.length} skills, ~${binder.tokenEstimate ?? '?'} tokens) into ${outDir}`);
  for (const item of written) {
    console.log(`  + ${item.title} -> ${item.path}`);
  }
  console.log(`bindry: ${written.length} skill(s) written. Re-run any time the Binder changes to stay in sync.`);


  // Copilot instructions files, when the server sent any. Like the always-on block these go relative
  // to the repo root rather than into --out, because Copilot decides where they live
  // (.github/instructions/), not us.
  //
  // Whole-file writes, unlike the always-on block: each one is a file Bindry owns end to end, with
  // no hand-written content to preserve and no other Binder sharing it.
  //
  // Empty for Claude Code and Codex, which have no path matching — so this loop simply does not run
  // on those targets rather than needing a per-platform branch.
  for (const instruction of binder.instructions ?? []) {
    if (!instruction.path || !instruction.content) continue;
    const target = resolve(process.cwd(), instruction.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, instruction.content, 'utf8');
    console.log(`bindry: path-matched instructions written to ${target}`);
  }

  // The always-on instructions go to the repo root, not into --out: CLAUDE.md is loaded by virtue
  // of where it sits, and --out points at the skills directory. cwd is the repo root in normal use,
  // and the path is printed either way so it is never a surprise where this landed.
  const preamble = binder.preamble;
  if (preamble && preamble.path && preamble.block) {
    const target = resolve(process.cwd(), preamble.path);
    mkdirSync(dirname(target), { recursive: true });
    const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const after = splicePreamble(before, preamble.block);
    if (after === before) {
      console.log(`bindry: always-on instructions already current in ${target}.`);
    } else {
      writeFileSync(target, after, 'utf8');
      console.log(`bindry: always-on instructions written to ${target}${before ? ' (your existing content was kept)' : ''}.`);
    }
  }

  if (synced) {
    const configPath = writeConfig(synced);
    console.log(`bindry: remembered this Binder in ${configPath} — future runs can omit the Binder id.`);
    if (synced.version) {
      console.log(`bindry: pinned to version ${synced.version}. Re-runs stay on it until you pass --version latest.`);
    }
  }
}

// Only run the CLI when this file is executed directly — check-drift.mjs imports the helpers
// above without wanting a full compile to happen as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

// --- The Binder's always-on instructions (BIND-0239/0240) --------------------------------------
//
// Skills are chosen per task; this is not. Tone, voice, output style and persona have no trigger —
// "use when: writing anything" either never fires or always fires — so they cannot live in a skill
// and still apply reliably. They go in the one file each host loads on every turn.
//
// Copilot reads BOTH .github/copilot-instructions.md and AGENTS.md, so it could take either. It
// gets its own file deliberately: AGENTS.md is shared ground with Codex, and a repo with both
// plugins installed would otherwise have one file carrying a block meant for the other, applying
// the same persona twice to the same agent.
const PREAMBLE_PATHS = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  copilot: '.github/copilot-instructions.md'
};

function preamblePathFor(client) {
  return PREAMBLE_PATHS[client] ?? PREAMBLE_PATHS['claude-code'];
}

// Matches one Binder's block and nothing else.
//
// The slug is validated rather than regex-escaped: a Binder slug is already normalised to
// lowercase letters, digits and hyphens, so anything else is a caller bug and a silently
// never-matching pattern would hide it — this throws instead.
//
// The `\s` after the slug is load-bearing. Without it `binder=acme` would also match
// `binder=acme-voice`, and a compile would eat a different Binder's block. Non-greedy, so two
// adjacent blocks are never swallowed as one.
function preambleBlockPattern(slug) {
  if (!/^[a-z0-9-]+$/.test(String(slug ?? ''))) {
    throw new Error(`bindry: "${slug}" is not a valid Binder slug, so its always-on block cannot be located safely.`);
  }
  return new RegExp(
    `<!--\\s*bindry:preamble\\s+binder=${slug}\\s[\\s\\S]*?<!--\\s*/bindry:preamble\\s+binder=${slug}\\s*-->`
  );
}

/**
 * The Binder slug a rendered block belongs to, read out of its own opening marker.
 *
 * This exists because the first version took the slug as an argument, and the two writers disagreed
 * about what to pass: the plugin compiler passed the Binder's real slug, while `bindry pull` passed
 * whatever the user typed on the command line. Pull a Binder by its GUID and the pattern searched
 * for `binder=3f2504e0-…` inside a block that said `binder=git-flow`. It never matched, so every
 * single pull appended another copy of the same block.
 *
 * Deriving it from the block removes the class of bug rather than that one instance: the string
 * being written and the string being searched for are now the same string.
 */
function parsePreambleSlug(block) {
  const match = /<!--\s*bindry:preamble\s+binder=([a-z0-9-]+)[\s>]/.exec(block ?? '');
  if (!match) {
    // Loudly, because a block we cannot identify is one we would append forever. Silence here is
    // exactly what made the original bug invisible.
    throw new Error('bindry: this always-on block has no readable "bindry:preamble binder=" marker, so it cannot be placed safely.');
  }
  return match[1];
}

/**
 * Splices one Binder's block into a file's existing contents.
 *
 * The destination is a file the user owns — CLAUDE.md and AGENTS.md are hand-written and long
 * predate us — and more than one Binder may keep a block in it. So this replaces OUR block and
 * touches nothing else: never a whole-file write, never a reformat, never a line-ending change to
 * anything outside the markers.
 *
 * Returns the contents unchanged when the block is already current, so a second compile is a no-op
 * and nothing appears in the user's diff.
 */
function splicePreamble(existing, block) {
  const current = existing ?? '';
  const pattern = preambleBlockPattern(parsePreambleSlug(block));

  if (pattern.test(current)) return current.replace(pattern, block);

  const base = current.trimEnd();
  return `${base ? `${base}\n\n` : ''}${block}\n`;
}

/** Removes one Binder's block, for an uninstall. Leaves no gap where it was. */
function removePreamble(existing, slug) {
  const current = existing ?? '';
  const pattern = preambleBlockPattern(slug);
  if (!pattern.test(current)) return current;

  const stripped = current.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  return stripped ? `${stripped}\n` : '';
}
