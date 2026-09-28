// The on-disk format for a repository's rules folder (BIND-0197), and the reader and writer for it.
//
//   .bindry/
//     stack.json                  the Stack's own metadata
//     bindings/<slug>.json        one Binding per file
//
// JSON, not Markdown with frontmatter: a Binding carries several ordered lists (appliesWhen,
// doesNotApplyWhen, constraints, verification) and a full YAML parser to read them would be the CLI's
// first dependency. The fields are exactly the API's own draft shapes, so the round trip is lossless by
// construction rather than by a mapping table that can drift.
//
// The one concession to review: `instructions` may be a string OR an array of lines. A rule's prose is
// the part a reviewer actually reads, and a single JSON string puts a paragraph on one line where a diff
// is unreadable. An array gives line-by-line diffs at no cost — the writer emits one whenever the text
// has more than one line, and the reader joins it back with newlines.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export const SOURCE_DIR = '.bindry';
export const STACK_FILE = 'stack.json';
export const BINDINGS_DIR = 'bindings';

/** Instructions as stored on disk (string or lines) to the single string the API takes. */
export function textFrom(value) {
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'string' ? value : '';
}

/** Instructions as text to what belongs on disk: lines when multi-line, a plain string when not. */
export function linesFor(text) {
  const value = typeof text === 'string' ? text : '';
  return value.includes('\n') ? value.split('\n') : value;
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reads a rules folder. Returns { root, stack, bindings, problems } — bindings in filename order, which
 * is what decides the Stack's composition order, and problems as one entry per unreadable file rather
 * than an exception: a folder of forty rules with one bad file should say which file.
 */
export function readSourceFolder(dir) {
  const root = resolve(dir ?? SOURCE_DIR);
  const problems = [];

  const stackPath = join(root, STACK_FILE);
  if (!existsSync(stackPath)) {
    throw new Error(
      `no ${STACK_FILE} in ${root}. A rules folder needs one — it is what names the Stack this folder publishes to. ` +
      `Run "bindry eject <stack>" to generate a folder from a Stack you already have.`
    );
  }

  const stack = readJson(stackPath, problems, 'stack');
  if (!stack) {
    throw new Error(`${stackPath} is not valid JSON, so there is nothing to publish.`);
  }

  const bindingsDir = join(root, BINDINGS_DIR);
  const bindings = [];
  if (existsSync(bindingsDir)) {
    for (const entry of readdirSync(bindingsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const relativePath = `${SOURCE_DIR}/${BINDINGS_DIR}/${entry.name}`;
      const document = readJson(join(bindingsDir, entry.name), problems, relativePath);
      if (!document) continue;

      const binding = document.binding ?? document;
      const slug = slugify(binding.slug || basename(entry.name, '.json'));
      if (!slug) {
        problems.push({ path: relativePath, reason: 'no slug, and the filename does not produce one' });
        continue;
      }

      bindings.push({
        path: relativePath,
        version: typeof document.version === 'string' ? document.version : '',
        binding: { ...binding, slug, instructions: textFrom(binding.instructions) }
      });
    }
  }

  return { root, stack, bindings, problems };
}

/**
 * Writes a rules folder from a Stack and its Bindings. Replaces the bindings directory wholesale, so a
 * Binding removed from the Stack does not linger as a stale file that the next publish would put back.
 */
export function writeSourceFolder(dir, { stack, bindings }) {
  const root = resolve(dir ?? SOURCE_DIR);
  const bindingsDir = join(root, BINDINGS_DIR);

  mkdirSync(root, { recursive: true });
  if (existsSync(bindingsDir)) rmSync(bindingsDir, { recursive: true, force: true });
  mkdirSync(bindingsDir, { recursive: true });

  const written = [`${SOURCE_DIR}/${STACK_FILE}`];
  writeJson(join(root, STACK_FILE), stack);

  for (const binding of bindings) {
    const slug = slugify(binding.slug);
    const path = join(bindingsDir, `${slug}.json`);
    writeJson(path, { ...binding, instructions: linesFor(binding.instructions) });
    written.push(`${SOURCE_DIR}/${BINDINGS_DIR}/${slug}.json`);
  }

  return { root, written };
}

/** The Stack metadata fields a repo owns, from a full Stack entity. */
export function stackDocumentFrom(stack) {
  return {
    slug: stack.slug ?? '',
    title: stack.title ?? '',
    summary: stack.summary ?? '',
    category: stack.category ?? '',
    visibility: stack.visibility ?? 'Public',
    audience: stack.audience ?? [],
    tags: stack.tags ?? [],
    supportedTargets: stack.supportedTargets ?? [],
    tokenEstimate: stack.tokenEstimate ?? { estimated: 0, alwaysLoaded: 0, taskLoaded: 0 },
    trust: stack.trust ?? {}
  };
}

/** The Binding fields a repo owns, from a full Binding entity. Deliberately drops server-side state. */
export function bindingDocumentFrom(binding) {
  return {
    slug: binding.slug ?? '',
    title: binding.title ?? '',
    summary: binding.summary ?? '',
    category: binding.category ?? '',
    visibility: binding.visibility ?? 'Public',
    audience: binding.audience ?? [],
    tags: binding.tags ?? [],
    scope: {
      appliesWhen: binding.scope?.appliesWhen ?? [],
      doesNotApplyWhen: binding.scope?.doesNotApplyWhen ?? []
    },
    instructions: binding.instructions ?? '',
    constraints: binding.constraints ?? [],
    examples: binding.examples ?? [],
    verificationChecklist: binding.verificationChecklist ?? [],
    supportedTargets: binding.supportedTargets ?? [],
    tokenEstimate: binding.tokenEstimate ?? { estimated: 0, alwaysLoaded: 0, taskLoaded: 0 },
    trust: binding.trust ?? {}
  };
}

function readJson(path, problems, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push({ path: label, reason: `not valid JSON (${err.message})` });
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
