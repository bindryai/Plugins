#!/usr/bin/env node
// Build the same standalone Codex bundle for ZIP uploads and catalog review.
// Only tracked source files are copied; credentials, caches and local configuration stay out.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv[2];
if (!outputArg || !isAbsolute(outputArg)) throw new Error('Usage: node scripts/package-codex.mjs <new absolute output directory>');
const output = resolve(outputArg);
if (existsSync(output)) throw new Error('Output directory already exists; choose a fresh directory.');
const insideSource = relative(join(root, 'codex'), output);
if (!insideSource || (!insideSource.startsWith(`..${sep}`) && insideSource !== '..' && !isAbsolute(insideSource))) throw new Error('Output must be outside the source plugin directory.');
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'codex'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const entries = tracked.filter(path => !path.startsWith('codex/.agents/')).map(source => ({ source, destination: source.slice('codex/'.length) }));
entries.push({ source: 'LICENSE', destination: 'LICENSE' });
for (const required of ['.codex-plugin/plugin.json', 'README.md', 'SECURITY.md', 'assets/icon.svg', 'LICENSE']) {
  if (!entries.some(entry => entry.destination === required)) throw new Error(`Missing tracked package file: ${required}. Stage new source files first.`);
}
for (const entry of entries) {
  if (entry.destination.split('/').some(part => part === '..' || part === '.git')) throw new Error('Unsafe package path');
  if (lstatSync(join(root, entry.source)).isSymbolicLink()) throw new Error('Symlinks are not packaged');
}
mkdirSync(output);
for (const entry of entries) {
  const target = join(output, entry.destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, entry.source), target);
}
const manifest = JSON.parse(readFileSync(join(output, '.codex-plugin/plugin.json'), 'utf8'));
if (!manifest.requires_local_executor || !manifest.interface?.composerIcon || !manifest.interface?.logo) throw new Error('Desktop declaration and listing icons are required');
for (const field of ['composerIcon', 'logo']) {
  const asset = manifest.interface[field];
  if (!asset.startsWith('./') || asset.split('/').includes('..') || !existsSync(join(output, asset))) throw new Error(`Invalid packaged ${field}`);
}
console.log(JSON.stringify({ output, name: manifest.name, version: manifest.version, files: entries.length, requiresLocalExecutor: true }));
