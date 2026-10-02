// The on-disk format for a repository's rules folder (BIND-0197), and the reader and writer for it.
//
//   .bindry/
//     binder.json                  the Binder's own metadata
//     skills/<slug>.json        one Skill per file
//
// JSON, not Markdown with frontmatter: a Skill carries several ordered lists (appliesWhen,
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
export const BINDER_FILE = 'binder.json';
export const SKILLS_DIR = 'skills';

// The 0.1.x names, kept only to recognise a folder written by an older CLI and say so. Nothing
// reads a legacy folder — this is a diagnosis, not a compatibility path.
export const LEGACY_BINDER_FILE = 'stack.json';
export const LEGACY_SKILLS_DIR = 'bindings';

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
 * Reads a rules folder. Returns { root, binder, skills, problems } — skills in filename order, which
 * is what decides the Binder's composition order, and problems as one entry per unreadable file rather
 * than an exception: a folder of forty rules with one bad file should say which file.
 */
export function readSourceFolder(dir) {
  const root = resolve(dir ?? SOURCE_DIR);
  const problems = [];

  const binderPath = join(root, BINDER_FILE);
  if (!existsSync(binderPath)) {
    // A folder written by 0.1.x has stack.json and bindings/ instead. Saying "no binder.json" to
    // someone whose folder is full of rules they wrote would be the cryptic failure the 0.2.0
    // break was explicitly not allowed to produce: they did not write these names, and nothing on
    // screen would connect the error to an upgrade.
    if (existsSync(join(root, LEGACY_BINDER_FILE)) || existsSync(join(root, LEGACY_SKILLS_DIR))) {
      throw new Error(
        `${root} uses the pre-0.2.0 layout. Bindry 0.2.0 renamed Stacks to Binders and Bindings to ` +
        `skills, so this folder needs ${LEGACY_BINDER_FILE} renamed to ${BINDER_FILE} and ` +
        `${LEGACY_SKILLS_DIR}/ renamed to ${SKILLS_DIR}/. The file contents are unchanged — only the ` +
        `names moved. Or run "bindry eject <binder>" to regenerate the folder.`
      );
    }
    throw new Error(
      `no ${BINDER_FILE} in ${root}. A rules folder needs one — it is what names the Binder this folder publishes to. ` +
      `Run "bindry eject <binder>" to generate a folder from a Binder you already have.`
    );
  }

  const binder = readJson(binderPath, problems, 'binder');
  if (!binder) {
    throw new Error(`${binderPath} is not valid JSON, so there is nothing to publish.`);
  }

  const skillsDir = join(root, SKILLS_DIR);
  const skills = [];
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const relativePath = `${SOURCE_DIR}/${SKILLS_DIR}/${entry.name}`;
      const document = readJson(join(skillsDir, entry.name), problems, relativePath);
      if (!document) continue;

      const skill = document.skill ?? document;
      const slug = slugify(skill.slug || basename(entry.name, '.json'));
      if (!slug) {
        problems.push({ path: relativePath, reason: 'no slug, and the filename does not produce one' });
        continue;
      }

      skills.push({
        path: relativePath,
        version: typeof document.version === 'string' ? document.version : '',
        skill: { ...skill, slug, instructions: textFrom(skill.instructions) }
      });
    }
  }

  return { root, binder, skills, problems };
}

/**
 * Writes a rules folder from a Binder and its Skills. Replaces the skills directory wholesale, so a
 * Skill removed from the Binder does not linger as a stale file that the next publish would put back.
 */
export function writeSourceFolder(dir, { binder, skills }) {
  const root = resolve(dir ?? SOURCE_DIR);
  const skillsDir = join(root, SKILLS_DIR);

  mkdirSync(root, { recursive: true });
  if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });

  const written = [`${SOURCE_DIR}/${BINDER_FILE}`];
  writeJson(join(root, BINDER_FILE), binder);

  for (const skill of skills) {
    const slug = slugify(skill.slug);
    const path = join(skillsDir, `${slug}.json`);
    writeJson(path, { ...skill, instructions: linesFor(skill.instructions) });
    written.push(`${SOURCE_DIR}/${SKILLS_DIR}/${slug}.json`);
  }

  return { root, written };
}

/** The Binder metadata fields a repo owns, from a full Binder entity. */
export function binderDocumentFrom(binder) {
  return {
    slug: binder.slug ?? '',
    title: binder.title ?? '',
    summary: binder.summary ?? '',
    // Always-on instructions. A repo owns these the same way it owns its skills: they are the
    // Binder's voice, they belong in review beside the rules they colour, and a round trip that
    // dropped them would quietly republish a Binder with its persona removed.
    preamble: binder.preamble ?? '',
    category: binder.category ?? '',
    visibility: binder.visibility ?? 'Public',
    audience: binder.audience ?? [],
    tags: binder.tags ?? [],
    supportedTargets: binder.supportedTargets ?? [],
    tokenEstimate: binder.tokenEstimate ?? { estimated: 0, alwaysLoaded: 0, taskLoaded: 0 },
    trust: binder.trust ?? {}
  };
}

/** The Skill fields a repo owns, from a full Skill entity. Deliberately drops server-side state. */
export function skillDocumentFrom(skill) {
  return {
    slug: skill.slug ?? '',
    title: skill.title ?? '',
    summary: skill.summary ?? '',
    category: skill.category ?? '',
    visibility: skill.visibility ?? 'Public',
    audience: skill.audience ?? [],
    tags: skill.tags ?? [],
    scope: {
      appliesWhen: skill.scope?.appliesWhen ?? [],
      doesNotApplyWhen: skill.scope?.doesNotApplyWhen ?? []
    },
    instructions: skill.instructions ?? '',
    constraints: skill.constraints ?? [],
    examples: skill.examples ?? [],
    verificationChecklist: skill.verificationChecklist ?? [],
    supportedTargets: skill.supportedTargets ?? [],
    tokenEstimate: skill.tokenEstimate ?? { estimated: 0, alwaysLoaded: 0, taskLoaded: 0 },
    trust: skill.trust ?? {}
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
