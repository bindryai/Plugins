import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBinderDetail, resolveBinderExport, resolveSkillDetail } from '../api.mjs';
import { parsePinComment, parseLiveComment, hasLegacyComment } from '../compile.mjs';
import { printJson, printTable } from '../output.mjs';

// Read-only: never re-pulls or writes anything, mirroring Bindry.Plugins' own check-drift.mjs.
// Finds every SKILL.md under --dir, reads back the `bindry:pin`/`bindry:live` comment
// bindry pull wrote, and reports each against the Binder's *current* pinned version from the API —
// the local half of "version control" (BIND-0175's ask), pairing with pull's write half.
//
// DECIDED (BIND-0265): `check` does NOT look at Copilot's path-matched instruction files, and that
// is a known gap rather than an oversight.
//
// `pull` writes those to `.github/instructions/<slug>.instructions.md` at the repo root, because
// Copilot decides where they live. They are out of scope here twice over: wrong location (this scans
// `--dir`) and wrong filename (this looks for `SKILL.md`). Note the reason is NOT "they carry no
// marker" — they carry `<!-- bindry:instructions skill=<id> version=<v> -->`, so the id and version
// needed to resolve drift are both present.
//
// The consequence, stated plainly: **a path-shaped skill's drift is currently invisible to
// `bindry check`.** Pull it, let the Binder move on, and nothing reports it. Closing that means
// teaching this command a second location and a second marker shape, which is a feature rather than
// a tweak — so it is recorded here rather than done quietly as a side effect of BIND-0265.
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

/**
 * Checks pins that were pulled at a specific Binder version against what THAT version locked
 * (BIND-0257).
 *
 * Reads the versioned SkillBundle export rather than the Binder's current composition. That is a
 * heavier read than it looks — it pulls content in order to compare version strings — and it is the
 * only read available: the public listing exposes which versions exist (`publishedVersions`) but not
 * what any of them contained, and `PublicCatalogVersion` carries no skill list. Decided to live with
 * it rather than add a composition-at-version endpoint, because `check` is run occasionally and one
 * extra read is cheaper than a new API surface to keep correct.
 */
async function checkPinnedToVersion({ apiBase, token, binderSlug, binderVersion, binderPins, rows, notices }) {
  let exported;
  try {
    ({ binder: exported } = await resolveBinderExport(apiBase, token, binderSlug, 'SkillBundle', binderVersion));
  } catch (err) {
    // Covers both "that version is not published" (a 400 naming the ones that are) and a Binder
    // version whose own pins can no longer be honoured (a 409 from BIND-0253). Either way the right
    // answer is to surface the API's words, not to suggest re-pulling — re-pulling cannot conjure a
    // version back, and suggesting it is what this card exists to stop.
    for (const pin of binderPins) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: err.message });
    }
    return;
  }

  let bundle;
  try {
    bundle = JSON.parse(exported.content);
  } catch (err) {
    for (const pin of binderPins) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, note: `could not read the v${binderVersion} export (${err.message})` });
    }
    return;
  }

  const lockedBySkillId = new Map((bundle.skills ?? []).map((skill) => [skill.id, skill.version]));

  // Information, not staleness. Reported once per Binder, in wording that does not imply anything is
  // wrong, and deliberately with no instruction attached: taking the newer version is a decision the
  // person makes, which is the whole point of the Binder being locked.
  const latest = exported.currentVersion ?? null;
  if (latest && latest !== binderVersion) {
    notices.push({ binder: binderSlug, pinned: binderVersion, latest });
  }

  for (const pin of binderPins) {
    if (pin.mode === 'live') {
      const stillInVersion = lockedBySkillId.has(pin.skill);
      rows.push({
        ...pin,
        status: stillInVersion ? 'live' : 'unknown',
        currentVersion: null,
        binderLatest: latest,
        note: stillInVersion ? '' : `not part of v${binderVersion}`
      });
      continue;
    }

    const locked = lockedBySkillId.get(pin.skill);
    if (locked === undefined) {
      rows.push({ ...pin, status: 'unknown', currentVersion: null, binderLatest: latest, note: `not part of v${binderVersion}` });
    } else if (locked === pin.version) {
      // Holding exactly what was asked for. Silence is the correct output.
      rows.push({ ...pin, status: 'up to date', currentVersion: locked, binderLatest: latest, note: '' });
    } else {
      // Genuinely wrong: the local file is not what this Binder version locked, so it was edited or
      // the pull was partial. Re-pulling AT this version is the fix.
      rows.push({ ...pin, status: 'stale', currentVersion: locked, binderLatest: latest, note: `v${binderVersion} locks ${locked}` });
    }
  }
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

  // Grouped by Binder AND the Binder version it was pulled at (BIND-0257), because that version is
  // the thing a pin should be measured against. A pull that recorded `binder-version=1.0.0` is a
  // statement of intent: the right question is "do I still have what 1.0.0 locked", not "does this
  // match whatever the Binder contains now". Comparing against current told anyone deliberately
  // holding an older version that they were stale, and then told them to re-pull — which would have
  // abandoned the version they chose.
  const binderPinsByBinder = new Map();
  for (const pin of pins) {
    if (pin.binder === null) continue;
    const key = `${pin.binder}\u0000${pin.binderVersion ?? ''}`;
    if (!binderPinsByBinder.has(key)) binderPinsByBinder.set(key, { binderSlug: pin.binder, binderVersion: pin.binderVersion ?? null, binderPins: [] });
    binderPinsByBinder.get(key).binderPins.push(pin);
  }

  const rows = [];
  // Binder-level facts rather than per-skill ones: a newer version existing is information, not a
  // problem with any particular file, so it is reported separately and in different words.
  const notices = [];

  for (const { binderSlug, binderVersion, binderPins } of binderPinsByBinder.values()) {
    if (binderVersion) {
      await checkPinnedToVersion({ apiBase, token, binderSlug, binderVersion, binderPins, rows, notices });
      continue;
    }
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
    // Still a flat array. Wrapping it as { skills, binderUpdates } would read better but it is a
    // breaking change to a published CLI's machine contract, and it buys nothing: every row already
    // carries binderVersion and binderLatest, so a CI job can see "a newer Binder version exists"
    // without a shape change or parsing console text.
    printJson(rows);
    return;
  }

  printTable(rows, [
    { header: 'BINDER', value: (r) => r.binder ?? '(standalone Skill)' },
    { header: 'AT', value: (r) => r.binderVersion ?? '-' },
    { header: 'SKILL', value: (r) => r.skillDir },
    { header: 'PINNED', value: (r) => r.version ?? '-' },
    { header: 'EXPECTED', value: (r) => r.currentVersion ?? '-' },
    { header: 'STATUS', value: (r) => r.status },
    { header: 'NOTE', value: (r) => r.note }
  ]);

  // Printed before the staleness summary so a clean, deliberately-pinned install does not end on a
  // line that reads like a problem.
  for (const notice of notices) {
    console.log(
      `\nbindry: "${notice.binder}" is pinned at v${notice.pinned}; v${notice.latest} has since been published. ` +
      `Nothing changes until you choose it — pull again with --binder-version ${notice.latest} to take it.`
    );
  }

  const staleRows = rows.filter((r) => r.status === 'stale');
  if (staleRows.length > 0) {
    // The advice has to match the pin, or it undoes it. Telling someone holding v1.0.0 to
    // "pull again" moves them to current, which is the bug this card fixes.
    const pinned = staleRows.filter((r) => r.binderVersion);
    const unpinned = staleRows.filter((r) => !r.binderVersion);

    console.log(`\n${staleRows.length} skill(s) do not match what they were pulled at.`);
    for (const row of pinned) {
      console.log(`  ${row.skillDir}: run "bindry pull ${row.binder} --binder-version ${row.binderVersion}" to restore v${row.binderVersion}.`);
    }
    if (unpinned.length > 0) {
      console.log(`  Run "bindry pull <binder>" again to bring the unpinned ones up to date.`);
    }
    process.exitCode = 1;
  }
}
