// Renders one SkillBundle Skill into a SKILL.md — the same shape and pin-comment format
// Bindry.Plugins' claude-code/codex compile-binder.mjs already produce and check-drift.mjs already
// parses, so a Binder pulled by the CLI and one synced by a plugin land on disk identically.
// Deliberately duplicated rather than imported: those scripts are plugin-specific entry points
// (their own --out defaults, their own CLI surface) and this package must stand alone once
// published to npm, not reach across the repo into another package's source at runtime. Keeping
// the format identical is enforced by shared tests, not a shared module — see cli/src/compile.test.mjs
// and the plugins' own compile-binder.test.mjs, which assert on the same fixtures.

// A Skill pulled on its own (bindry pull <skill-id>, no Binder involved) carries a comment with
// no "binder=" field at all, rather than inventing a fake Binder identifier — "binder=<skill-id>"
// would misdescribe what actually happened. `binder: null` in the parsed/rendered shape means
// exactly that: this skill was compiled from a standalone Skill, not a Binder.
const PIN_PATTERN = /<!--\s*bindry:pin\s+(?:binder=(\S+)\s+)?skill=(\S+)\s+version=(\S+)\s*-->/;
const LIVE_PATTERN = /<!--\s*bindry:live\s+(?:binder=(\S+)\s+)?skill=(\S+)\s*-->/;

export function renderPinComment(binder, skill) {
  const binderPart = binder ? `binder=${binder.slug} ` : '';
  return `<!-- bindry:pin ${binderPart}skill=${skill.id} version=${skill.version} -->`;
}

export function renderLiveComment(binder, skill) {
  const binderPart = binder ? `binder=${binder.slug} ` : '';
  return `<!-- bindry:live ${binderPart}skill=${skill.id} -->`;
}

export function parsePinComment(contents) {
  const match = PIN_PATTERN.exec(contents);
  return match ? { binder: match[1] ?? null, skill: match[2], version: match[3] } : null;
}

// 0.1.x wrote `stack=`/`binding=` instead. A SKILL.md carrying those parses as neither a pin nor a
// live marker, so without this `bindry check` would report "no compiled skills with a marker found"
// against a folder full of them — and the user did not write those files, so nothing on screen
// would connect the message to an upgrade. Recognition only; nothing reads a legacy marker.
const LEGACY_PATTERN = /<!--\s*bindry:(pin|live)\s+(?:stack=\S+\s+)?binding=\S+/;

export function hasLegacyComment(contents) {
  return LEGACY_PATTERN.test(contents);
}

export function parseLiveComment(contents) {
  const match = LIVE_PATTERN.exec(contents);
  return match ? { binder: match[1] ?? null, skill: match[2] } : null;
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The description is loaded for EVERY skill in a Binder on every turn, so it is the one piece of
// output with an unavoidable per-turn cost. The cap bounds what we ADD and never shortens the
// title or the "Use when" clause, so a skill with no exclusions renders exactly what it rendered
// before this existed.
const MAX_DESCRIPTION_LENGTH = 500;

const formatExclusions = (exclusions) => ` Not for: ${exclusions.join('; ')}.`;

// Exclusions belong in the description, not only in the body: every host loads name and
// description for all skills, then loads the body only once a skill has been chosen. A
// "does not apply when" that lives solely in the body cannot prevent a wrong selection — it can
// only persuade the model to back out after it has already paid to load the file.
//
// Exclusions are dropped as whole clauses, never cut mid-phrase: half a condition reads as a
// different condition, and a rule that quietly means something else is worse than one that is absent.
function describeSkill(skill) {
  const trigger = skill.appliesWhen?.length
    ? skill.appliesWhen.join('; ')
    : skill.title;
  const head = `${skill.title}. Use when: ${trigger}.`;

  const exclusions = skill.doesNotApplyWhen ?? [];
  if (exclusions.length === 0) return head;

  // Author order is deliberate: the first one listed is the one they thought of first.
  const kept = [];
  for (const exclusion of exclusions) {
    if (head.length + formatExclusions([...kept, exclusion]).length > MAX_DESCRIPTION_LENGTH) break;
    kept.push(exclusion);
  }

  return kept.length === 0 ? head : head + formatExclusions(kept);
}

export function renderSkill(binder, skill, mode) {
  const lines = ['---', `name: ${slugify(skill.slug ?? skill.title)}`, `description: ${describeSkill(skill).replace(/"/g, "'")}`, '---', ''];

  if (mode === 'live') {
    lines.push(
      renderLiveComment(binder, skill),
      '',
      'This skill is compiled in **live** mode — its instructions are not stored locally. Before proceeding, ' +
        `call the \`bindry.skills.get\` MCP tool with \`{"skillId": "${skill.id}"}\` and follow the ` +
        '`instructions`, `constraints`, and `verificationChecklist` it returns. Treat this file as a pointer only.',
      '',
      'If the tool call fails (not connected, network, auth/scope error), say so plainly and stop — do not guess.'
    );
  } else {
    lines.push(renderPinComment(binder, skill), '', skill.instructions.trim());

    if (skill.doesNotApplyWhen?.length) {
      lines.push('', 'Does not apply when:', ...skill.doesNotApplyWhen.map((item) => `- ${item}`));
    }
    if (skill.constraints?.length) {
      lines.push('', 'Constraints:', ...skill.constraints.map((item) => `- ${item}`));
    }
    if (skill.verification?.length) {
      lines.push('', 'Verify before finishing:', ...skill.verification.map((item) => `- ${item}`));
    }
  }

  lines.push('');
  return lines.join('\n');
}
