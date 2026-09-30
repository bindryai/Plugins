import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveStackDetail, resolveBindingDetail } from '../api.mjs';
import { parsePinComment, parseLiveComment } from '../compile.mjs';
import { printJson, printTable } from '../output.mjs';

// Read-only: never re-pulls or writes anything, mirroring Bindry.Plugins' own check-drift.mjs.
// Finds every SKILL.md under --dir, reads back the `bindry:pin`/`bindry:live` comment
// bindry pull wrote, and reports each against the Stack's *current* pinned version from the API —
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
  // A `bindry pull` writes one directory per Stack under --out (default ./bindry/<stack-slug>),
  // so this looks one level deeper than findCompiledSkills' own directory, unless --dir points
  // straight at a single Stack's output already.
  const candidateDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(skillsDir, e.name))
        .concat(skillsDir)
    : [skillsDir];

  const pins = [];
  for (const candidate of candidateDirs) {
    for (const { skillDir, skillPath } of findCompiledSkills(candidate)) {
      const contents = readFileSync(skillPath, 'utf8');
      const pin = parsePinComment(contents);
      const live = pin ? null : parseLiveComment(contents);
      if (pin) pins.push({ skillDir, skillPath, ...pin, mode: 'pinned' });
      else if (live) pins.push({ skillDir, skillPath, ...live, version: null, mode: 'live' });
    }
  }

  if (pins.length === 0) {
    console.log(`bindry: no compiled skills with a bindry:pin or bindry:live marker found under ${skillsDir}.`);
    return;
  }

  // A pin with no stack= field came from a standalone Binding pull (BIND-0190) — there's no Stack to
  // group it under, and no shared lookup to share across pins the way a Stack's bindings share one
  // resolveStackDetail call. Each one is resolved on its own, by its own binding id.
  const standalonePins = pins.filter((pin) => pin.stack === null);
  const stackPinsByStack = new Map();
  for (const pin of pins) {
    if (pin.stack === null) continue;
    if (!stackPinsByStack.has(pin.stack)) stackPinsByStack.set(pin.stack, []);
    stackPinsByStack.get(pin.stack).push(pin);
  }

  const rows = [];
  for (const [stackSlug, stackPins] of stackPinsByStack) {
    let detail;
    try {
      ({ detail } = await resolveStackDetail(apiBase, token, stackSlug));
    } catch (err) {
      for (const pin of stackPins) {
        rows.push({ ...pin, status: 'unknown', currentVersion: null, note: err.message });
      }
      continue;
    }
    const currentByBindingId = new Map((detail.bindings ?? []).map((b) => [b.bindingId, b.pinnedVersion]));
    for (const pin of stackPins) {
      if (pin.mode === 'live') {
        const stillInStack = currentByBindingId.has(pin.binding);
        rows.push({ ...pin, status: stillInStack ? 'live' : 'unknown', currentVersion: null, note: stillInStack ? '' : 'no longer part of this Stack' });
        continue;
      }
      const currentVersion = currentByBindingId.get(pin.binding);
      if (currentVersion === undefined) {
        rows.push({ ...pin, status: 'unknown', currentVersion: null, note: 'no longer part of this Stack' });
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
      ({ detail } = await resolveBindingDetail(apiBase, token, pin.binding));
    } catch (err) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: err.message });
      continue;
    }
    const currentVersion = detail.currentVersion ?? detail.listing?.currentVersion ?? null;
    if (pin.mode === 'live') {
      rows.push({ ...pin, status: 'live', currentVersion: null, note: '' });
    } else if (currentVersion === null) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: "couldn't read this Binding's current version" });
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
    { header: 'STACK', value: (r) => r.stack ?? '(standalone Binding)' },
    { header: 'SKILL', value: (r) => r.skillDir },
    { header: 'PINNED', value: (r) => r.version ?? '-' },
    { header: 'CURRENT', value: (r) => r.currentVersion ?? '-' },
    { header: 'STATUS', value: (r) => r.status },
    { header: 'NOTE', value: (r) => r.note }
  ]);

  const stale = rows.filter((r) => r.status === 'stale').length;
  if (stale > 0) {
    console.log(`\n${stale} skill(s) are stale. Run "bindry pull <stack>" again to bring them up to date.`);
    process.exitCode = 1;
  }
}
