// Turns an instruction file into a Binding draft (BIND-0205).
//
// Structured formats parse deterministically: a SKILL.md already IS a Binding — a name, a
// description, a body — so there is nothing to infer and nothing to charge for. What no source
// format carries is Bindry's appliesWhen / doesNotApplyWhen / verification split, so an imported
// Binding is thin by design. Enriching it is a separate, opt-in step; guessing here would produce
// confident nonsense in the field that decides when a rule fires.

import { basename, dirname } from 'node:path';

/** Reads a leading --- fenced block. Returns { data, body }; data is {} when there is no block. */
export function splitFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { data: {}, body: content };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    data[field[1]] = stripQuotes(field[2].trim());
  }

  return { data, body: content.slice(match[0].length) };
}

function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A Binding draft from one scanned file, or null when there is nothing usable in it.
 * `source` is what scanForInstructionFiles returned; `provenance` is recorded so an imported
 * Binding can always be traced back to the file it came from.
 */
export function toBindingDraft(source, { provenance } = {}) {
  if (!source.content) return null;

  const parsed = PARSERS[source.kind]?.(source);
  if (!parsed) return null;

  const instructions = parsed.instructions?.trim();
  if (!instructions) return null;

  const title = parsed.title?.trim() || titleFromPath(source.relativePath);
  const slug = slugify(parsed.slug || title);
  if (!slug) return null;

  return {
    slug,
    title,
    summary: (parsed.summary?.trim() || firstSentence(instructions)).slice(0, 280),
    instructions,
    appliesWhen: parsed.appliesWhen ?? [],
    tags: parsed.tags ?? [],
    sourcePath: source.relativePath,
    provenance: provenance ? `${provenance} — ${source.relativePath}` : source.relativePath
  };
}

const PARSERS = {
  /** Agent Skills: name and description in frontmatter, instructions in the body. */
  skill(source) {
    const { data, body } = splitFrontmatter(source.content);
    return {
      slug: data.name,
      title: data.name ? titleFromSlug(data.name) : null,
      summary: data.description,
      instructions: body,
      // The description doubles as the trigger in every agent that reads these, so it is the
      // closest thing the format has to appliesWhen — but it is prose, not a list of moments, so
      // it goes in as one entry rather than being split on punctuation and guessed at.
      appliesWhen: data.description ? [data.description.trim()] : [],
      tags: ['imported', 'agent-skill']
    };
  },

  /** Cursor .mdc: description, globs, alwaysApply. */
  'cursor-rule'(source) {
    const { data, body } = splitFrontmatter(source.content);
    const name = basename(source.relativePath).replace(/\.mdc$/, '');
    return {
      slug: name,
      title: titleFromSlug(name),
      summary: data.description,
      instructions: body,
      appliesWhen: globsToAppliesWhen(data.globs),
      tags: ['imported', 'cursor']
    };
  },

  /** Windsurf rules: trigger, description, globs. */
  'windsurf-rule'(source) {
    const { data, body } = splitFrontmatter(source.content);
    const name = basename(source.relativePath).replace(/\.md$/, '');
    return {
      slug: name,
      title: titleFromSlug(name),
      summary: data.description,
      instructions: body,
      appliesWhen: globsToAppliesWhen(data.globs),
      tags: ['imported', 'windsurf']
    };
  },

  /** Copilot .instructions.md: applyTo is a glob, description and name are optional. */
  'copilot-instructions'(source) {
    const { data, body } = splitFrontmatter(source.content);
    const name = basename(source.relativePath).replace(/\.instructions\.md$/, '');
    return {
      slug: data.name || name,
      title: data.name ? titleFromSlug(data.name) : titleFromSlug(name),
      summary: data.description,
      instructions: body,
      appliesWhen: globsToAppliesWhen(data.applyTo),
      tags: ['imported', 'copilot']
    };
  }
};

/**
 * A path pattern is not a task moment — "src/**\/*.ts" says where, not when. Recorded as a
 * literal "working in" line so the information is not lost, and so it is obvious to a human
 * editing the Binding later that this needs rewriting into a real trigger.
 */
function globsToAppliesWhen(globs) {
  if (!globs) return [];
  return String(globs)
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map((glob) => `Working in files matching ${glob}`);
}

function titleFromSlug(slug) {
  return String(slug)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function titleFromPath(relativePath) {
  const name = basename(relativePath);
  if (name === 'SKILL.md') return titleFromSlug(basename(dirname(relativePath)));
  return titleFromSlug(name.replace(/\.(instructions\.md|mdc|md)$/, ''));
}

function firstSentence(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const stop = trimmed.indexOf('. ');
  return stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
}
