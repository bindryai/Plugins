#!/usr/bin/env node
// Compiles a Bindry Stack export into one GitHub Copilot skill per Binding.
// Reads the export from a local file, a full export URL, a Stack GUID *or marketplace slug*
// (fetched live from --api-base), or — if no source is given — whatever was last synced,
// remembered in ./bindry.config.json.
//
// Usage:
//   node compile-stack.mjs <stack-export.json> [--out <dir>]
//   node compile-stack.mjs <stack-id-or-slug> --api-base <url> [--token <api-key>] [--out <dir>] [--mode pinned|live]
//   node compile-stack.mjs --api-base <url> [--token <api-key>]   (reuses bindry.config.json, incl. --mode)
//
// Two kinds of Stack resolve here. Your own (workspace-scoped, may be private) needs --token and comes
// from /api/stacks/{guid}/export/file. Someone else's published Stack needs no token at all and comes
// from /api/public/catalog/stacks/{slug-or-guid}/export/file — that public route is what makes installing
// a Stack from the marketplace possible without owning the workspace that wrote it. A token is tried
// first when present, then the public route: a key scoped to your own workspace must not stop you
// installing a public Stack.
//
// --mode live compiles a pointer skill per Binding that calls the Bindry MCP tools for current
// content at run time, instead of embedding a snapshot. Requires the Bindry MCP server to be
// connected separately — see skills/bindry-connect/SKILL.md. Default is --mode pinned (unchanged
// snapshot behavior); the mode is remembered in bindry.config.json like the Stack id and API base.
//
// This is GitHub Copilot's copy of the same compiler that ships with the Claude Code plugin
// (../../claude-code/scripts/compile-stack.mjs) — identical logic, since Copilot uses the same
// SKILL.md format. Kept as a self-contained copy rather than a shared import: installed plugins
// live at independent, versioned cache paths per platform with no guaranteed shared filesystem
// layout, so each plugin bundles its own scripts. The only behavioral difference is the default
// output directory below (Copilot's first project-local skills directory is .github/skills, not
// .claude/skills).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'bindry.config.json';
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_PATTERN = /<!--\s*bindry:pin\s+stack=(\S+)\s+binding=(\S+)\s+version=(\S+)\s*-->/;
const LIVE_PATTERN = /<!--\s*bindry:live\s+stack=(\S+)\s+binding=(\S+)\s*-->/;

// Shared with check-drift.mjs, which parses this same line back out of a compiled SKILL.md
// rather than re-implementing the pin format.
export function renderPinComment(stack, binding) {
  return `<!-- bindry:pin stack=${stack.slug} binding=${binding.id} version=${binding.version} -->`;
}

export function parsePinComment(contents) {
  const match = PIN_PATTERN.exec(contents);
  return match ? { stack: match[1], binding: match[2], version: match[3] } : null;
}

// A live-compiled skill has no version to pin — it always calls the MCP server for current
// content — so it carries this sibling marker instead. Kept separate from renderPinComment
// rather than merged so the already-tested pinned-mode format/output stays untouched.
export function renderLiveComment(stack, binding) {
  return `<!-- bindry:live stack=${stack.slug} binding=${binding.id} -->`;
}

export function parseLiveComment(contents) {
  const match = LIVE_PATTERN.exec(contents);
  return match ? { stack: match[1], binding: match[2] } : null;
}

export function parseArgs(argv) {
  const args = { input: null, out: '.github/skills', apiBase: null, token: null, target: 'SkillBundle', mode: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--api-base') args.apiBase = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
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

function describeSkill(binding) {
  const trigger = binding.appliesWhen?.length
    ? binding.appliesWhen.join('; ')
    : binding.title;
  return `${binding.title}. Use when: ${trigger}.`;
}

function renderSkill(stack, binding, assets, mode) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${slugify(binding.slug ?? binding.title)}`);
  lines.push(`description: ${describeSkill(binding).replace(/"/g, "'")}`);
  lines.push('---');
  lines.push('');

  if (mode === 'live') {
    lines.push(renderLiveComment(stack, binding));
    lines.push('');
    lines.push(
      'This skill is compiled in **live** mode — its instructions are not stored locally. Before proceeding, ' +
      `call the \`bindry.bindings.get\` MCP tool with \`{"bindingId": "${binding.id}"}\` and follow the ` +
      '`instructions`, `constraints`, and `verificationChecklist` it returns. Treat this file as a pointer only.'
    );
    lines.push('');
    lines.push(
      'If the tool call fails (not connected, network, auth/scope error), say so plainly and stop — do not ' +
      'guess. If the Bindry MCP server isn\'t connected yet, use the `bindry-connect` skill first.'
    );
  } else {
    lines.push(renderPinComment(stack, binding));
    lines.push('');
    lines.push(binding.instructions.trim());

    if (binding.doesNotApplyWhen?.length) {
      lines.push('');
      lines.push('Does not apply when:');
      for (const item of binding.doesNotApplyWhen) lines.push(`- ${item}`);
    }

    if (binding.constraints?.length) {
      lines.push('');
      lines.push('Constraints:');
      for (const item of binding.constraints) lines.push(`- ${item}`);
    }

    if (binding.verification?.length) {
      lines.push('');
      lines.push('Verify before finishing:');
      for (const item of binding.verification) lines.push(`- ${item}`);
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

async function downloadAssets(binding, skillDir, args) {
  const attachments = binding.attachments ?? [];
  if (attachments.length === 0) return [];

  const downloaded = [];

  for (const attachment of attachments) {
    if (!attachment.fileName || !attachment.url) {
      console.warn(`bindry: skipping an attachment on "${binding.title}" missing "fileName" or "url".`);
      continue;
    }

    const fileName = basename(attachment.fileName);
    const assetUrl = resolveAssetUrl(attachment.url, args.apiBase);
    if (!assetUrl) {
      console.warn(
        `bindry: skipping asset "${fileName}" on "${binding.title}" — its URL (${attachment.url}) is relative ` +
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
      console.warn(`bindry: skipping asset "${fileName}" on "${binding.title}" — could not reach ${assetUrl} (${err.message}).`);
      continue;
    }

    if (!response.ok) {
      console.warn(`bindry: skipping asset "${fileName}" on "${binding.title}" — ${assetUrl} responded ${response.status} ${response.statusText}.`);
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

function workspaceExportUrl(apiBase, stackId, target) {
  return `${apiBase.replace(/\/$/, '')}/api/stacks/${stackId}/export/file?target=${encodeURIComponent(target)}`;
}

function publicExportUrl(apiBase, slugOrId, target) {
  const base = apiBase.replace(/\/$/, '');
  return `${base}/api/public/catalog/stacks/${encodeURIComponent(slugOrId)}/export/file?target=${encodeURIComponent(target)}`;
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

// Resolves a Stack by GUID or marketplace slug. The workspace route is only attempted for a GUID with a
// token — it cannot serve a slug, and without a token it can only ever 401. Anything it declines
// (401/403/404) falls through to the public catalog, so "I have a key for my own workspace" never becomes
// "I can't install a public Stack".
async function fetchLive(slugOrId, apiBase, token, target) {
  const isGuid = GUID_PATTERN.test(slugOrId);
  let workspaceStatus = null;

  if (token && isGuid) {
    const url = workspaceExportUrl(apiBase, slugOrId, target);
    const response = await requestExport(url, token);
    if (response.ok) return readExportJson(response, url);
    if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
      fail(`export request failed: ${response.status} ${response.statusText} (${url})`);
    }
    workspaceStatus = response.status;
  }

  const publicUrl = publicExportUrl(apiBase, slugOrId, target);
  const publicResponse = await requestExport(publicUrl, null);
  if (publicResponse.ok) return readExportJson(publicResponse, publicUrl);

  if (publicResponse.status === 404) {
    if (workspaceStatus === 401 || workspaceStatus === 403) {
      fail(
        `authentication failed (${workspaceStatus}) for Stack ${slugOrId} in your workspace, and it is not ` +
        `published to the public catalog either. Check --token (generate one from Bindry → Account settings ` +
        `→ API keys, with the Exports permission), or set BINDRY_API_TOKEN.`
      );
    }
    fail(
      token || !isGuid
        ? `Stack "${slugOrId}" was not found at ${apiBase}. A public Stack must be Published with Public ` +
          `visibility to be installable; a private one needs --token.`
        : `Stack "${slugOrId}" is not in the public catalog at ${apiBase}. If it's your own private Stack, ` +
          `pass --token <api-key> (or set BINDRY_API_TOKEN).`
    );
  }
  if (publicResponse.status === 401 || publicResponse.status === 403) {
    fail(
      `authentication failed (${publicResponse.status}) fetching ${publicUrl}. ` +
      `Pass --token <api-key> (generate one from Bindry → Account settings → API keys), ` +
      `or set the BINDRY_API_TOKEN environment variable. This Stack may be private.`
    );
  }
  fail(`export request failed: ${publicResponse.status} ${publicResponse.statusText} (${publicUrl})`);
}

// A path, not an identifier: has a separator, ends in .json, or names a file that actually exists.
// Anything else is treated as a Stack GUID or marketplace slug.
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

async function resolveStack(args, mode) {
  // Explicit local file path. Deliberately NOT "anything that isn't a GUID" any more: a marketplace slug
  // like `git-flow-command-center` is a perfectly good Stack identifier, and the old rule would have tried
  // to open it as a file and failed with a confusing "no such file".
  if (args.input && !/^https?:\/\//i.test(args.input) && looksLikeLocalFile(args.input)) {
    return { stack: loadLocalFile(resolve(process.cwd(), args.input)), synced: null };
  }

  // Explicit full export URL.
  if (args.input && /^https?:\/\//i.test(args.input)) {
    const response = await fetch(args.input, args.token ? { headers: { 'X-Api-Key': args.token } } : undefined);
    if (!response.ok) fail(`export request failed: ${response.status} ${response.statusText} (${args.input})`);
    return { stack: await response.json(), synced: null };
  }

  // Bare Stack GUID or marketplace slug, or no input at all (falls back to the remembered config).
  let stackId = args.input;
  let apiBase = args.apiBase;
  if (!stackId) {
    const config = readConfig();
    if (!config?.stackId) {
      fail(
        'no source given and no bindry.config.json found. Usage: node compile-stack.mjs <stack-export.json | stack-id-or-slug> --api-base <url> [--token <api-key>]'
      );
    }
    stackId = config.stackId;
    apiBase = apiBase ?? config.apiBase;
  }
  if (!apiBase) {
    fail('--api-base is required when syncing a Stack id or slug (e.g. --api-base http://localhost:5160).');
  }

  const stack = await fetchLive(stackId, apiBase, args.token, args.target);
  return { stack, synced: { stackId, apiBase, mode } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? readConfig()?.mode ?? 'pinned';
  if (mode !== 'pinned' && mode !== 'live') {
    fail(`--mode must be "pinned" or "live", got "${mode}".`);
  }

  const { stack, synced } = await resolveStack(args, mode);

  if (!stack.slug || !Array.isArray(stack.bindings) || stack.bindings.length === 0) {
    fail('the resolved Stack export is missing "slug" or a non-empty "bindings" array — is this a Bindry Stack export?');
  }

  const outDir = resolve(process.cwd(), args.out);
  const written = [];

  for (const binding of stack.bindings) {
    if (!binding.slug || !binding.instructions) {
      console.warn(`bindry: skipping a binding missing "slug" or "instructions" in ${stack.slug}`);
      continue;
    }
    if (mode === 'live' && !GUID_PATTERN.test(binding.id ?? '')) {
      console.warn(
        `bindry: skipping "${binding.title}" in live mode — its id ("${binding.id}") isn't a GUID, so ` +
        `bindry.bindings.get would never be able to look it up at agent run-time.`
      );
      continue;
    }
    const skillDir = join(outDir, slugify(binding.slug));
    mkdirSync(skillDir, { recursive: true });
    const assets = await downloadAssets(binding, skillDir, args);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(stack, binding, assets, mode), 'utf8');
    written.push({ title: binding.title, path: skillPath });
  }

  console.log(`bindry: compiled "${stack.title ?? stack.slug}" (${stack.bindings.length} bindings, ~${stack.tokenEstimate ?? '?'} tokens) into ${outDir}`);
  for (const item of written) {
    console.log(`  + ${item.title} -> ${item.path}`);
  }
  console.log(`bindry: ${written.length} skill(s) written. Re-run any time the Stack changes to stay in sync.`);

  if (synced) {
    const configPath = writeConfig(synced);
    console.log(`bindry: remembered this Stack in ${configPath} — future runs can omit the Stack id.`);
  }
}

// Only run the CLI when this file is executed directly — check-drift.mjs imports the helpers
// above without wanting a full compile to happen as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
