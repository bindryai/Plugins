// Renders one SkillBundle Binding into a SKILL.md — the same shape and pin-comment format
// Bindry.Plugins' claude-code/codex compile-stack.mjs already produce and check-drift.mjs already
// parses, so a Stack pulled by the CLI and one synced by a plugin land on disk identically.
// Deliberately duplicated rather than imported: those scripts are plugin-specific entry points
// (their own --out defaults, their own CLI surface) and this package must stand alone once
// published to npm, not reach across the repo into another package's source at runtime. Keeping
// the format identical is enforced by shared tests, not a shared module — see cli/src/compile.test.mjs
// and the plugins' own compile-stack.test.mjs, which assert on the same fixtures.

const PIN_PATTERN = /<!--\s*bindry:pin\s+stack=(\S+)\s+binding=(\S+)\s+version=(\S+)\s*-->/;
const LIVE_PATTERN = /<!--\s*bindry:live\s+stack=(\S+)\s+binding=(\S+)\s*-->/;

export function renderPinComment(stack, binding) {
  return `<!-- bindry:pin stack=${stack.slug} binding=${binding.id} version=${binding.version} -->`;
}

export function renderLiveComment(stack, binding) {
  return `<!-- bindry:live stack=${stack.slug} binding=${binding.id} -->`;
}

export function parsePinComment(contents) {
  const match = PIN_PATTERN.exec(contents);
  return match ? { stack: match[1], binding: match[2], version: match[3] } : null;
}

export function parseLiveComment(contents) {
  const match = LIVE_PATTERN.exec(contents);
  return match ? { stack: match[1], binding: match[2] } : null;
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function describeSkill(binding) {
  const trigger = binding.appliesWhen?.length ? binding.appliesWhen.join('; ') : binding.title;
  return `${binding.title}. Use when: ${trigger}.`;
}

export function renderSkill(stack, binding, mode) {
  const lines = ['---', `name: ${slugify(binding.slug ?? binding.title)}`, `description: ${describeSkill(binding).replace(/"/g, "'")}`, '---', ''];

  if (mode === 'live') {
    lines.push(
      renderLiveComment(stack, binding),
      '',
      'This skill is compiled in **live** mode — its instructions are not stored locally. Before proceeding, ' +
        `call the \`bindry.bindings.get\` MCP tool with \`{"bindingId": "${binding.id}"}\` and follow the ` +
        '`instructions`, `constraints`, and `verificationChecklist` it returns. Treat this file as a pointer only.',
      '',
      'If the tool call fails (not connected, network, auth/scope error), say so plainly and stop — do not guess.'
    );
  } else {
    lines.push(renderPinComment(stack, binding), '', binding.instructions.trim());

    if (binding.doesNotApplyWhen?.length) {
      lines.push('', 'Does not apply when:', ...binding.doesNotApplyWhen.map((item) => `- ${item}`));
    }
    if (binding.constraints?.length) {
      lines.push('', 'Constraints:', ...binding.constraints.map((item) => `- ${item}`));
    }
    if (binding.verification?.length) {
      lines.push('', 'Verify before finishing:', ...binding.verification.map((item) => `- ${item}`));
    }
  }

  lines.push('');
  return lines.join('\n');
}
