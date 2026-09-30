import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBinderDetail, resolveSkillDetail } from '../api.mjs';
import { parsePinComment, parseLiveComment, hasLegacyComment } from '../compile.mjs';
import { printJson, printTable } from '../output.mjs';

// Read-only: never re-pulls or writes anything, mirroring Bindry.Plugins' own check-drift.mjs.
// Finds every SKILL.md under --dir, reads back the `bindry:pin`/`bindry:live` comment
// bindry pull wrote, and reports each against the Binder's *current* pinned version from the API —
// the local half of "version control" (BIND-0175's ask), pairing with pull's write half.
function findCompiledSkills(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    if (existsSync(skillPath)) found.push({ skillDir: entry.name, skillPath });
  }
  return found;
}

export async function check({ apiBase, token, dir, json }) {
  const skillsDir = resolve(dir ?? join('.', 'bindry'));
  // A `bindry pull` writes one directory per Binder under --out (default ./bindry/<binder-slug>),
  // so this looks one level deeper than findCompiledSkills' own directory, unless --dir points
  // straight at a single Binder's output already.
  const candidateDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(skillsDir, e.name))
        .concat(skillsDir)
    : [skillsDir];

  const pins = [];
  let legacy = 0;
  for (const candidate of candidateDirs) {
    for (const { skillDir, skillPath } of findCompiledSkills(candidate)) {
      const contents = readFileSync(skillPath, 'utf8');
      const pin = parsePinComment(contents);
      const live = pin ? null : parseLiveComment(contents);
      if (pin) pins.push({ skillDir, skillPath, ...pin, mode: 'pinned' });
      else if (live) pins.push({ skillDir, skillPath, ...live, version: null, mode: 'live' });
      else if (hasLegacyComment(contents)) legacy++;
    }
  }

  if (pins.length === 0) {
    // Counted separately so the folder that was pulled by 0.1.x is told what happened, rather than
    // being told its markers do not exist.
    if (legacy > 0) {
      console.log(
        `bindry: ${legacy} compiled skill(s) under ${skillsDir} were pulled by Bindry 0.1.x. ` +
        `0.2.0 renamed Stacks to Binders and Bindings to skills, and the markers inside those files ` +
        `moved with them — re-run "bindry pull <binder>" to regenerate them.`
      );
      return;
    }
    console.log(`bindry: no compiled skills with a bindry:pin or bindry:live marker found under ${skillsDir}.`);
    return;
  }

  // A pin with no binder= field came from a standalone Skill pull (BIND-0190) — there's no Binder to
  // group it under, and no shared lookup to share across pins the way a Binder's skills share one
  // resolveBinderDetail call. Each one is resolved on its own, by its own skill id.
  const standalonePins = pins.filter((pin) => pin.binder === null);
  const binderPinsByBinder = new Map();
  for (const pin of pins) {
    if (pin.binder === null) continue;
    if (!binderPinsByBinder.has(pin.binder)) binderPinsByBinder.set(pin.binder, []);
    binderPinsByBinder.get(pin.binder).push(pin);
  }

  const rows = [];
  for (const [binderSlug, binderPins] of binderPinsByBinder) {
    let detail;
    try {
      ({ detail } = await resolveBinderDetail(apiBase, token, binderSlug));
    } catch (err) {
      for (const pin of binderPins) {
        rows.push({ ...pin, status: 'unknown', currentVersion: null, note: err.message });
      }
      continue;
    }
    const currentBySkillId = new Map((detail.skills ?? []).map((b) => [b.skillId, b.pinnedVersion]));
    for (const pin of binderPins) {
      if (pin.mode === 'live') {
        const stillInBinder = currentBySkillId.has(pin.skill);
        rows.push({ ...pin, status: stillInBinder ? 'live' : 'unknown', currentVersion: null, note: stillInBinder ? '' : 'no longer part of this Binder' });
        continue;
      }
      const currentVersion = currentBySkillId.get(pin.skill);
      if (currentVersion === undefined) {
        rows.push({ ...pin, status: 'unknown', currentVersion: null, note: 'no longer part of this Binder' });
      } else if (currentVersion === pin.version) {
        rows.push({ ...pin, status: 'up to date', currentVersion, note: '' });
      } else {
        rows.push({ ...pin, status: 'stale', currentVersion, note: '' });
      }
    }
  }

  for (const pin of standalonePins) {
    let detail;
    try {
      ({ detail } = await resolveSkillDetail(apiBase, token, pin.skill));
    } catch (err) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: err.message });
      continue;
    }
    const currentVersion = detail.currentVersion ?? detail.listing?.currentVersion ?? null;
    if (pin.mode === 'live') {
      rows.push({ ...pin, status: 'live', currentVersion: null, note: '' });
    } else if (currentVersion === null) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: "couldn't read this Skill's current version" });
    } else if (currentVersion === pin.version) {
      rows.push({ ...pin, status: 'up to date', currentVersion, note: '' });
    } else {
      rows.push({ ...pin, status: 'stale', currentVersion, note: '' });
    }
  }

  if (json) {
    printJson(rows);
    return;
  }

  printTable(rows, [
    { header: 'BINDER', value: (r) => r.binder ?? '(standalone Skill)' },
    { header: 'SKILL', value: (r) => r.skillDir },
    { header: 'PINNED', value: (r) => r.version ?? '-' },
    { header: 'CURRENT', value: (r) => r.currentVersion ?? '-' },
    { header: 'STATUS', value: (r) => r.status },
    { header: 'NOTE', value: (r) => r.note }
  ]);

  const stale = rows.filter((r) => r.status === 'stale').length;
  if (stale > 0) {
    console.log(`\n${stale} skill(s) are stale. Run "bindry pull <binder>" again to bring them up to date.`);
    process.exitCode = 1;
  }
}
