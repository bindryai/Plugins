#!/usr/bin/env node
// CI smoke test for this repo: catches a malformed manifest, a broken SKILL.md/command frontmatter,
// or a compiler regression before it lands on a branch. Read-only, no network calls, no external deps.
//
// Usage: node scripts/validate.mjs

import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function fail(message) {
  console.error(`FAIL: ${message}`);
  failures++;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function readJson(relPath) {
  const path = join(ROOT, relPath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${relPath} is not valid JSON (${err.message})`);
    return null;
  }
}

function checkManifest(relPath, requiredFields) {
  const json = readJson(relPath);
  if (!json) return;
  const missing = requiredFields.filter((field) => json[field] === undefined);
  if (missing.length > 0) {
    fail(`${relPath} is missing required field(s): ${missing.join(', ')}`);
    return;
  }
  ok(`${relPath} parses and has required fields`);
}

function parseFrontmatter(contents) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (fieldMatch) fields[fieldMatch[1]] = fieldMatch[2];
  }
  return fields;
}

function checkFrontmatter(relPath, requiredFields) {
  const path = join(ROOT, relPath);
  const contents = readFileSync(path, 'utf8');
  const fields = parseFrontmatter(contents);
  if (!fields) {
    fail(`${relPath} has no YAML frontmatter block (expected to start with "---")`);
    return;
  }
  const missing = requiredFields.filter((field) => !fields[field]?.trim());
  if (missing.length > 0) {
    fail(`${relPath} frontmatter is missing required field(s): ${missing.join(', ')}`);
    return;
  }
  ok(`${relPath} frontmatter has required fields`);
}

function checkSyntax(relPath) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, relPath)], { stdio: 'pipe' });
    ok(`${relPath} is syntactically valid`);
  } catch (err) {
    fail(`${relPath} failed \`node --check\` (${err.stderr?.toString().trim() || err.message})`);
  }
}

function checkCompiler(platform, exampleFile) {
  const compilerPath = join(ROOT, platform, 'scripts', 'compile-stack.mjs');
  const examplePath = join(ROOT, platform, 'examples', exampleFile);
  if (!existsSync(compilerPath) || !existsSync(examplePath)) {
    fail(`${platform}: missing compiler or example fixture for ${exampleFile}`);
    return;
  }

  const stack = JSON.parse(readFileSync(examplePath, 'utf8'));
  const outDir = mkdtempSync(join(tmpdir(), 'bindry-validate-'));

  try {
    execFileSync(process.execPath, [compilerPath, examplePath, '--out', outDir], { stdio: 'pipe' });

    for (const binding of stack.bindings) {
      const skillPath = join(outDir, binding.slug, 'SKILL.md');
      if (!existsSync(skillPath)) {
        fail(`${platform}/${exampleFile}: compiling did not produce ${binding.slug}/SKILL.md`);
        continue;
      }
      const fields = parseFrontmatter(readFileSync(skillPath, 'utf8'));
      if (!fields?.name || !fields?.description) {
        fail(`${platform}/${exampleFile}: compiled ${binding.slug}/SKILL.md is missing name/description frontmatter`);
      }
    }
    ok(`${platform}: compiled ${exampleFile} (${stack.bindings.length} binding(s)) into valid skills`);
  } catch (err) {
    fail(`${platform}: compiling ${exampleFile} failed (${err.stderr?.toString().trim() || err.message})`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// --- Manifests ---
checkManifest('.claude-plugin/marketplace.json', ['name', 'plugins']);
checkManifest('claude-code/.claude-plugin/plugin.json', ['name', 'version', 'description']);
checkManifest('codex/.agents/plugins/marketplace.json', ['name', 'plugins']);
checkManifest('codex/.codex-plugin/plugin.json', ['name', 'version', 'description', 'skills']);

// --- Claude Code commands ---
for (const file of readdirSync(join(ROOT, 'claude-code', 'commands'))) {
  if (file.endsWith('.md')) checkFrontmatter(`claude-code/commands/${file}`, ['description']);
}

// --- Codex skills ---
for (const dir of readdirSync(join(ROOT, 'codex', 'skills'), { withFileTypes: true })) {
  if (dir.isDirectory()) checkFrontmatter(`codex/skills/${dir.name}/SKILL.md`, ['name', 'description']);
}

// --- Script syntax ---
for (const platform of ['claude-code', 'codex']) {
  checkSyntax(`${platform}/scripts/compile-stack.mjs`);
  checkSyntax(`${platform}/scripts/check-drift.mjs`);
}

// --- Compiler regression smoke test, both platforms, both bundled examples ---
for (const platform of ['claude-code', 'codex']) {
  for (const exampleFile of readdirSync(join(ROOT, platform, 'examples'))) {
    if (exampleFile.endsWith('.stack.json')) checkCompiler(platform, exampleFile);
  }
}

console.log('');
if (failures > 0) {
  console.error(`bindry: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('bindry: all checks passed.');
