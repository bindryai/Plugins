#!/usr/bin/env node
// Compiles a Bindry Stack export into one Claude Code skill per Binding.
// Reads the export from a local file, a full export URL, a bare Stack GUID (fetched live
// from --api-base), or — if no source is given — whatever was last synced, remembered in
// ./bindry.config.json.
//
// Usage:
//   node compile-stack.mjs <stack-export.json> [--out <dir>]
//   node compile-stack.mjs <stack-id-guid> --api-base <url> [--token <api-key>] [--out <dir>]
//   node compile-stack.mjs --api-base <url> [--token <api-key>]   (reuses bindry.config.json)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'bindry.config.json';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_PATTERN = /<!--\s*bindry:pin\s+stack=(\S+)\s+binding=(\S+)\s+version=(\S+)\s*-->/;

// Shared with check-drift.mjs, which parses this same line back out of a compiled SKILL.md
// rather than re-implementing the pin format.
export function renderPinComment(stack, binding) {
  return `<!-- bindry:pin stack=${stack.slug} binding=${binding.id} version=${binding.version} -->`;
}

export function parsePinComment(contents) {
  const match = PIN_PATTERN.exec(contents);
  return match ? { stack: match[1], binding: match[2], version: match[3] } : null;
}

export function parseArgs(argv) {
  const args = { input: null, out: '.claude/skills', apiBase: null, token: null, target: 'SkillBundle' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--api-base') args.apiBase = argv[++i];
    else if (argv[i] === '--token') args.token = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
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

function renderSkill(stack, binding, assets) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${slugify(binding.slug ?? binding.title)}`);
  lines.push(`description: ${describeSkill(binding).replace(/"/g, "'")}`);
  lines.push('---');
  lines.push('');
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

async function fetchLive(stackId, apiBase, token, target) {
  const url = `${apiBase.replace(/\/$/, '')}/api/stacks/${stackId}/export/file?target=${encodeURIComponent(target)}`;
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
      `or set the BINDRY_API_TOKEN environment variable. This Stack may be private.`
    );
  }
  if (response.status === 404) {
    fail(`Stack ${stackId} was not found at ${apiBase} — check the Stack id and that it belongs to your workspace.`);
  }
  if (!response.ok) {
    fail(`export request failed: ${response.status} ${response.statusText} (${url})`);
  }

  try {
    return await response.json();
  } catch (err) {
    fail(`response from ${url} was not valid JSON (${err.message}). Is --target set to a JSON-producing target?`);
  }
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

async function resolveStack(args) {
  // Explicit local file path (existing behavior — anything that isn't a bare GUID or URL).
  if (args.input && !GUID_PATTERN.test(args.input) && !/^https?:\/\//i.test(args.input)) {
    return { stack: loadLocalFile(resolve(process.cwd(), args.input)), synced: null };
  }

  // Explicit full export URL.
  if (args.input && /^https?:\/\//i.test(args.input)) {
    const response = await fetch(args.input, args.token ? { headers: { 'X-Api-Key': args.token } } : undefined);
    if (!response.ok) fail(`export request failed: ${response.status} ${response.statusText} (${args.input})`);
    return { stack: await response.json(), synced: null };
  }

  // Bare Stack GUID or no input at all (falls back to the remembered config).
  let stackId = args.input;
  let apiBase = args.apiBase;
  if (!stackId) {
    const config = readConfig();
    if (!config?.stackId) {
      fail(
        'no source given and no bindry.config.json found. Usage: node compile-stack.mjs <stack-export.json | stack-id> --api-base <url> [--token <api-key>]'
      );
    }
    stackId = config.stackId;
    apiBase = apiBase ?? config.apiBase;
  }
  if (!apiBase) {
    fail('--api-base is required when syncing a Stack id (e.g. --api-base http://localhost:5160).');
  }

  const stack = await fetchLive(stackId, apiBase, args.token, args.target);
  return { stack, synced: { stackId, apiBase } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { stack, synced } = await resolveStack(args);

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
    const skillDir = join(outDir, slugify(binding.slug));
    mkdirSync(skillDir, { recursive: true });
    const assets = await downloadAssets(binding, skillDir, args);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(stack, binding, assets), 'utf8');
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
