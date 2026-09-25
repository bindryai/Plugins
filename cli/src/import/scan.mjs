// Finds the instruction files a developer already has, on local disk (BIND-0205).
//
// Local only, deliberately: the agent doing this is already sitting in the checked-out repo, so
// reading github.com would add an App, scopes, rate limits, webhooks and a stored credential for
// files that are already here.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Where each format lives, and how to read it. `kind` decides the parser; `structured` decides
 * whether it can be turned into a Binding deterministically (free, instant) or needs the AI
 * segmentation path (costs credits, and is offered rather than assumed).
 */
const SOURCES = [
  { kind: 'skill', structured: true, dirs: ['.claude/skills', '.agents/skills', '.github/skills'], file: 'SKILL.md' },
  { kind: 'cursor-rule', structured: true, dirs: ['.cursor/rules'], extensions: ['.mdc'] },
  { kind: 'windsurf-rule', structured: true, dirs: ['.windsurf/rules'], extensions: ['.md'] },
  { kind: 'copilot-instructions', structured: true, dirs: ['.github/instructions'], extensions: ['.instructions.md'] },
  { kind: 'copilot-repo-instructions', structured: false, files: ['.github/copilot-instructions.md'] },
  { kind: 'agents-md', structured: false, files: ['AGENTS.md'] }
];

/** Skill folders carry runnable tooling beside the markdown. We read instructions, not executables. */
const IGNORED_SUBDIRECTORIES = new Set(['scripts', 'assets', 'references', 'node_modules', '.git']);

const MAX_FILE_BYTES = 200_000;

/**
 * Everything importable under `root`, as { path, relativePath, kind, structured, content }.
 * Unreadable or oversized files come back with a `skipped` reason instead of content, because a
 * partial import is the normal case and silently dropping a file is how someone loses a rule.
 */
export function scanForInstructionFiles(root) {
  const found = [];

  for (const source of SOURCES) {
    for (const file of source.files ?? []) {
      const path = join(root, file);
      if (existsSync(path) && isFile(path)) found.push(describe(root, path, source));
    }

    for (const dir of source.dirs ?? []) {
      const base = join(root, dir);
      if (!existsSync(base) || !isDirectory(base)) continue;

      for (const path of walk(base, source)) {
        found.push(describe(root, path, source));
      }
    }
  }

  // Stable order regardless of filesystem enumeration, so a report reads the same twice running.
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function* walk(dir, source) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_SUBDIRECTORIES.has(entry.name)) continue;
      yield* walk(path, source);
      continue;
    }

    if (!entry.isFile()) continue;

    if (source.file && entry.name === source.file) {
      yield path;
      continue;
    }

    if (source.extensions?.some((extension) => entry.name.endsWith(extension))) {
      yield path;
    }
  }
}

function describe(root, path, source) {
  const base = {
    path,
    relativePath: relative(root, path).split(sep).join('/'),
    kind: source.kind,
    structured: source.structured
  };

  try {
    const stats = statSync(path);
    if (stats.size > MAX_FILE_BYTES) {
      return { ...base, skipped: `larger than ${Math.round(MAX_FILE_BYTES / 1000)}KB` };
    }
    const content = readFileSync(path, 'utf8');
    if (!content.trim()) return { ...base, skipped: 'empty' };
    return { ...base, content };
  } catch (err) {
    return { ...base, skipped: `could not be read (${err.code ?? err.message})` };
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
