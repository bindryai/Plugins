import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveStackExport, resolveBindingExport, BindryApiError } from '../api.mjs';
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

function writeStackSkillBundle({ source, content, out, id, mode }) {
  let stack;
  try {
    stack = JSON.parse(content);
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
    if (!binding.slug || (mode === 'pinned' && !binding.instructions)) {
      console.warn(`bindry: skipping a Binding missing "slug" or "instructions" in ${stack.slug}.`);
      continue;
    }
    const skillDir = join(outDir, slugify(binding.slug));
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, renderSkill(pinStackRef, binding, mode), 'utf8');
    written.push({ title: binding.title, path: skillPath });
  }

  console.log(
    `bindry: pulled "${stack.title ?? stack.slug}" (${source}, ${stack.bindings.length} Bindings, ~${stack.tokenEstimate ?? '?'} tokens) into ${outDir}`
  );
  for (const item of written) console.log(`  + ${item.title} -> ${item.path}`);
  console.log(`bindry: ${written.length} skill(s) written. Run "bindry check" any time to see if the Stack has moved on.`);
}

function writeBindingSkillBundle({ source, content, out, id, mode }) {
  let binding;
  try {
    binding = JSON.parse(content);
  } catch (err) {
    throw new Error(`the SkillBundle export for "${id}" was not valid JSON (${err.message}).`);
  }
  if (!binding.slug || (mode === 'pinned' && !binding.instructions)) {
    throw new Error(`the resolved Binding "${id}" is missing "slug" or "instructions".`);
  }

  // No Stack is involved in a standalone Binding pull, so the pin comment carries no stack= field
  // at all (see compile.mjs) rather than a fabricated one — `bindry check` treats that as "look this
  // Binding up directly," not "look up a Stack named after a Binding."
  const outDir = resolve(out ?? join('.', 'bindry'));
  const skillDir = join(outDir, slugify(binding.slug));
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, renderSkill(null, binding, mode), 'utf8');

  console.log(`bindry: pulled "${binding.title ?? binding.slug}" (${source}, ~${binding.tokenEstimate ?? '?'} tokens) -> ${skillPath}`);
  console.log('bindry: 1 skill written. Run "bindry check" any time to see if it has moved on.');
}

// Pulls a Stack or a standalone Binding (yours, if --token resolves it, otherwise the public
// Library) into local files. Tries Stack resolution first — a bare Binding is far less common than
// a Stack, and every existing Stack-pull test/behavior needs to stay on that same first branch — and
// falls back to a Binding only on a real 404, not on an auth failure (which resolveStackExport
// already turns into a thrown error before this ever sees it).
//
// --target skill-bundle (the default) writes one SKILL.md per Binding (or the single Binding, for a
// standalone pull) — the same format and pin comment `bindry check` and the Claude Code/Codex
// plugins already read. --target markdown/agents-md instead writes the single compiled file
// Bindry's API already produces for that format.
export async function pull({ apiBase, token, id, out, target: targetFlag, mode }) {
  const target = resolveTarget(targetFlag);
  const resolvedMode = mode ?? 'pinned';
  if (resolvedMode !== 'pinned' && resolvedMode !== 'live') {
    throw new Error(`--mode must be "pinned" or "live", got "${resolvedMode}".`);
  }

  let kind;
  let source;
  let result;
  try {
    ({ source, stack: result } = await resolveStackExport(apiBase, token, id, target));
    kind = 'Stack';
  } catch (err) {
    if (!(err instanceof BindryApiError) || err.status !== 404) throw err;
    try {
      ({ source, binding: result } = await resolveBindingExport(apiBase, token, id, target));
      kind = 'Binding';
    } catch (bindingErr) {
      if (bindingErr instanceof BindryApiError && bindingErr.status === 404) {
        throw new Error(`no Stack or Binding "${id}" found (checked your workspace and the public Library).`);
      }
      throw bindingErr;
    }
  }

  if (target !== 'SkillBundle') {
    const outDir = resolve(out ?? '.');
    mkdirSync(outDir, { recursive: true });
    const filePath = join(outDir, result.fileName || `${slugify(id)}.md`);
    writeFileSync(filePath, result.content, 'utf8');
    const title = kind === 'Stack' ? result.stackTitle : result.bindingTitle;
    console.log(`bindry: pulled "${title ?? id}" (${source}) as ${target} -> ${filePath}`);
    return;
  }

  if (kind === 'Stack') {
    writeStackSkillBundle({ source, content: result.content, out, id, mode: resolvedMode });
  } else {
    writeBindingSkillBundle({ source, content: result.content, out, id, mode: resolvedMode });
  }
}
