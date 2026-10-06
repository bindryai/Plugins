import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { resolveBinderExport, resolveSkillExport, BindryApiError } from '../api.mjs';
import { renderSkill, slugify, splicePreamble } from '../compile.mjs';

const TARGET_ALIASES = {
  markdown: 'Markdown',
  'agents-md': 'AgentsMd',
  'skill-bundle': 'SkillBundle',
  copy: 'Copy'
};

export function resolveTarget(value) {
  const target = TARGET_ALIASES[value ?? 'skill-bundle'];
  if (!target) {
    throw new Error(`unknown --target "${value}". Use one of: ${Object.keys(TARGET_ALIASES).join(', ')}.`);
  }
  return target;
}

function writeBinderSkillBundle({ source, content, out, id, mode, binderVersion }) {
  let binder;
  try {
    binder = JSON.parse(content);
  } catch (err) {
    throw new Error(`the SkillBundle export for "${id}" was not valid JSON (${err.message}).`);
  }
  const skills = Array.isArray(binder.skills) ? binder.skills : [];
  const instructions = Array.isArray(binder.instructions) ? binder.instructions : [];

  // On Copilot a path-shaped skill compiles to a .github/instructions file INSTEAD OF a SKILL.md, so
  // a Binder of purely file-shaped conventions exports with an empty skills array and its content in
  // instructions[]. The question is whether the server sent anything to write, not whether there are
  // skills (BIND-0262 in the plugin compilers, BIND-0265 here).
  if (!binder.slug) {
    throw new Error(`the resolved Binder "${id}" is missing "slug".`);
  }
  if (skills.length === 0 && instructions.length === 0) {
    throw new Error(`the resolved Binder "${id}" has no Skills and no instruction files to write.`);
  }

  const outDir = resolve(out ?? join('.', 'bindry', slugify(binder.slug)));
  // The pin comment records `id` — what was actually typed to `bindry pull` — not binder.slug from
  // the compiled content. A private Binder's content still carries its public-facing slug even when
  // it has no public listing at all, and `bindry check` re-resolves by re-running the exact same
  // lookup `pull` did; recording the content's slug there would send check down the public-only
  // path and 404 on a private Binder that was pulled by GUID.
  // `version` is set only when a Binder version was pinned, and goes into the pin comment as
  // `binder-version=`. The skill's own `version=` records what each file contains; this records
  // which published Binder version those files came from, which is the question "am I deliberately
  // behind, or just behind?" needs answering.
  const pinBinderRef = { slug: id, version: binderVersion ?? null };
  const written = [];
  for (const skill of skills) {
    if (!skill.slug || (mode === 'pinned' && !skill.instructions)) {
      console.warn(`bindry: skipping a Skill missing "slug" or "instructions" in ${binder.slug}.`);
      continue;
    }
    const skillDir = join(outDir, slugify(skill.slug));
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(pinBinderRef, skill, mode), 'utf8');
    written.push({ title: skill.title, path: skillPath });
  }

  const at = binderVersion ? ` at v${binderVersion}` : '';
  console.log(
    `bindry: pulled "${binder.title ?? binder.slug}"${at} (${source}, ${skills.length} Skills, ~${binder.tokenEstimate ?? '?'} tokens) into ${outDir}`
  );
  for (const item of written) console.log(`  + ${item.title} -> ${item.path}`);

  const instructionsWritten = writePathMatchedInstructions(instructions, id);
  writeAlwaysOnInstructions(binder, id);

  // Both counts, so a pull that produced only instruction files does not report "0 skill(s) written"
  // and read as a failed pull.
  const summary = [`${written.length} skill(s)`];
  if (instructionsWritten > 0) summary.push(`${instructionsWritten} path-matched instruction file(s)`);
  console.log(`bindry: ${summary.join(' and ')} written. Run "bindry check" any time to see if the Binder has moved on.`);
}

function writeSkillSkillBundle({ source, content, out, id, mode }) {
  let skill;
  try {
    skill = JSON.parse(content);
  } catch (err) {
    throw new Error(`the SkillBundle export for "${id}" was not valid JSON (${err.message}).`);
  }
  if (!skill.slug || (mode === 'pinned' && !skill.instructions)) {
    throw new Error(`the resolved Skill "${id}" is missing "slug" or "instructions".`);
  }

  // No Binder is involved in a standalone Skill pull, so the pin comment carries no binder= field
  // at all (see compile.mjs) rather than a fabricated one — `bindry check` treats that as "look this
  // Skill up directly," not "look up a Binder named after a Skill."
  const outDir = resolve(out ?? join('.', 'bindry'));
  const skillDir = join(outDir, slugify(skill.slug));
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, renderSkill(null, skill, mode), 'utf8');

  console.log(`bindry: pulled "${skill.title ?? skill.slug}" (${source}, ~${skill.tokenEstimate ?? '?'} tokens) -> ${skillPath}`);
  console.log('bindry: 1 skill written. Run "bindry check" any time to see if it has moved on.');
}

// Pulls a Binder or a standalone Skill (yours, if --token resolves it, otherwise the public
// Library) into local files. Tries Binder resolution first — a bare Skill is far less common than
// a Binder, and every existing Binder-pull test/behavior needs to stay on that same first branch — and
// falls back to a Skill only on a real 404, not on an auth failure (which resolveBinderExport
// already turns into a thrown error before this ever sees it).
//
// --target skill-bundle (the default) writes one SKILL.md per Skill (or the single Skill, for a
// standalone pull) — the same format and pin comment `bindry check` and the Claude Code/Codex
// plugins already read. --target markdown/agents-md instead writes the single compiled file
// Bindry's API already produces for that format.
export async function pull({ apiBase, token, id, out, target: targetFlag, mode, binderVersion }) {
  const target = resolveTarget(targetFlag);
  const resolvedMode = mode ?? 'pinned';
  if (resolvedMode !== 'pinned' && resolvedMode !== 'live') {
    throw new Error(`--mode must be "pinned" or "live", got "${resolvedMode}".`);
  }
  // Named --binder-version, not --version: the CLI's own -v/--version is intercepted before any
  // command runs, so `pull x --version 1.0.0` would print the CLI version and exit. `publish` already
  // spells it this way.
  const requestedVersion = binderVersion?.trim() || undefined;
  if (requestedVersion && resolvedMode === 'live') {
    // A live compile resolves content through MCP at run time, which is the opposite of pinning:
    // accepting both would hand back files that claim a version and then change underneath it.
    throw new Error('--binder-version cannot be combined with --mode live: a live compile is not pinned to anything.');
  }

  let kind;
  let source;
  let result;
  try {
    ({ source, binder: result } = await resolveBinderExport(apiBase, token, id, target, requestedVersion));
    kind = 'Binder';
  } catch (err) {
    if (!(err instanceof BindryApiError) || err.status !== 404) throw err;
    // Only a Binder has versions, so asking for one and then silently pulling a standalone Skill
    // would quietly ignore the flag — say what happened instead.
    if (requestedVersion) {
      throw new Error(`no Binder "${id}" found, and --binder-version only applies to a Binder.`);
    }
    try {
      ({ source, skill: result } = await resolveSkillExport(apiBase, token, id, target));
      kind = 'Skill';
    } catch (skillErr) {
      if (skillErr instanceof BindryApiError && skillErr.status === 404) {
        throw new Error(`no Binder or Skill "${id}" found (checked your workspace and the public Library).`);
      }
      throw skillErr;
    }
  }

  if (target !== 'SkillBundle') {
    const outDir = resolve(out ?? '.');
    mkdirSync(outDir, { recursive: true });
    const filePath = join(outDir, result.fileName || `${slugify(id)}.md`);
    writeFileSync(filePath, result.content, 'utf8');
    const title = kind === 'Binder' ? result.binderTitle : result.skillTitle;
    const at = result.version ? ` at v${result.version}` : '';
    console.log(`bindry: pulled "${title ?? id}"${at} (${source}) as ${target} -> ${filePath}`);
    return;
  }

  if (kind === 'Binder') {
    // result.version is the version the API actually served, in the version row's own casing — not
    // the string that was typed, which may differ in case.
    writeBinderSkillBundle({
      source,
      content: result.content,
      out,
      id,
      mode: resolvedMode,
      binderVersion: result.version || null
    });
  } else {
    writeSkillSkillBundle({ source, content: result.content, out, id, mode: resolvedMode });
  }
}

/**
 * Writes the Binder's always-on instructions into the file the agent host loads on every turn.
 *
 * Goes to the repo root rather than into --out: CLAUDE.md is loaded by virtue of where it sits, and
 * --out points at the skills directory. cwd is the repo root in normal use, and the resolved path is
 * printed either way so it is never a surprise where this landed.
 *
 * Three rules, because the destination is a file the user owns and may have written entirely by
 * hand: splice our block only, keep everything else byte for byte, and say nothing and change
 * nothing when the block is already current.
 */
// Copilot's path-matched instruction files (BIND-0245), when the server sent any.
//
// These go relative to the repo ROOT, not into --out, because Copilot decides where they live
// (.github/instructions/) and not us — the same reason the always-on block below ignores --out.
// Whole-file writes, unlike the always-on block: each one is a file Bindry owns end to end, with no
// hand-written content to preserve and no other Binder sharing it.
//
// Empty for Claude Code and Codex, which have no path matching, so this simply does not run on those
// targets rather than needing a per-platform branch.
function writePathMatchedInstructions(instructions, id) {
  let count = 0;
  const root = process.cwd();

  for (const instruction of instructions) {
    if (!instruction.path || !instruction.content) continue;

    const target = resolve(root, instruction.path);

    // The path comes from the server, and resolve() against cwd would happily follow "../.." out of
    // the repository and overwrite something outside it. Today the server builds these paths itself
    // (SkillFileRenderer: ".github/instructions/<slug>.instructions.md"), so this should never fire —
    // which is exactly why it is cheap to check rather than to trust. Refusing loudly beats writing
    // outside the directory the user ran `bindry pull` in.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(
        `the Binder "${id}" asked to write an instruction file outside this directory ` +
        `("${instruction.path}"). Refusing.`
      );
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, instruction.content, 'utf8');
    count += 1;
    console.log(`bindry: path-matched instructions written to ${target}`);
  }

  return count;
}

function writeAlwaysOnInstructions(binder, id) {
  const preamble = binder.preamble;
  if (!preamble || !preamble.path || !preamble.block) return;

  // No key is passed: splicePreamble reads the slug out of the block it is writing.
  //
  // Passing one separately WAS the bug. This function sent slugify(id) — what the user typed on the
  // command line — while the block itself carried the Binder's real slug. Pull by GUID and the two
  // never matched, so the pattern found nothing and every pull appended another copy of the block.
  const target = resolve(process.cwd(), preamble.path);
  mkdirSync(dirname(target), { recursive: true });

  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const after = splicePreamble(before, preamble.block);

  if (after === before) {
    console.log(`bindry: always-on instructions already current in ${target}.`);
    return;
  }

  writeFileSync(target, after, 'utf8');
  console.log(
    `bindry: always-on instructions written to ${target}` +
    `${before ? ' (your existing content was kept)' : ''}.`
  );
}
