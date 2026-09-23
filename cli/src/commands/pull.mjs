import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveStackExport } from '../api.mjs';
import { renderSkill, slugify } from '../compile.mjs';

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

// Pulls a Stack (yours, if --token resolves it, otherwise the public Library) into local files.
// --target skill-bundle (the default) writes one SKILL.md per Binding, the same format and pin
// comment `bindry check` and the Claude Code/Codex plugins already read — a Stack pulled here and
// one synced by a plugin are interchangeable on disk. --target markdown/agents-md instead writes
// the single compiled file Bindry's API already produces for that format.
export async function pull({ apiBase, token, id, out, target: targetFlag, mode }) {
  const target = resolveTarget(targetFlag);
  const resolvedMode = mode ?? 'pinned';
  if (resolvedMode !== 'pinned' && resolvedMode !== 'live') {
    throw new Error(`--mode must be "pinned" or "live", got "${resolvedMode}".`);
  }

  const { source, stack: result } = await resolveStackExport(apiBase, token, id, target);

  if (target !== 'SkillBundle') {
    const outDir = resolve(out ?? '.');
    mkdirSync(outDir, { recursive: true });
    const filePath = join(outDir, result.fileName || `${slugify(id)}.md`);
    writeFileSync(filePath, result.content, 'utf8');
    console.log(`bindry: pulled "${result.stackTitle ?? id}" (${source}) as ${target} -> ${filePath}`);
    return;
  }

  let stack;
  try {
    stack = JSON.parse(result.content);
  } catch (err) {
    throw new Error(`the SkillBundle export for "${id}" was not valid JSON (${err.message}).`);
  }
  if (!stack.slug || !Array.isArray(stack.bindings) || stack.bindings.length === 0) {
    throw new Error(`the resolved Stack "${id}" is missing "slug" or a non-empty "bindings" array.`);
  }

  const outDir = resolve(out ?? join('.', 'bindry', slugify(stack.slug)));
  // The pin comment records `id` — what was actually typed to `bindry pull` — not stack.slug from
  // the compiled content. A private Stack's content still carries its public-facing slug even when
  // it has no public listing at all, and `bindry check` re-resolves by re-running the exact same
  // lookup `pull` did; recording the content's slug there would send check down the public-only
  // path and 404 on a private Stack that was pulled by GUID.
  const pinStackRef = { slug: id };
  const written = [];
  for (const binding of stack.bindings) {
    if (!binding.slug || (resolvedMode === 'pinned' && !binding.instructions)) {
      console.warn(`bindry: skipping a Binding missing "slug" or "instructions" in ${stack.slug}.`);
      continue;
    }
    const skillDir = join(outDir, slugify(binding.slug));
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(pinStackRef, binding, resolvedMode), 'utf8');
    written.push({ title: binding.title, path: skillPath });
  }

  console.log(
    `bindry: pulled "${stack.title ?? stack.slug}" (${source}, ${stack.bindings.length} Bindings, ~${stack.tokenEstimate ?? '?'} tokens) into ${outDir}`
  );
  for (const item of written) console.log(`  + ${item.title} -> ${item.path}`);
  console.log(`bindry: ${written.length} skill(s) written. Run "bindry check" any time to see if the Stack has moved on.`);
}
