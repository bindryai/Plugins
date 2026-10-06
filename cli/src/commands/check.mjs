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
// Copilot's path-matched instruction files (BIND-0267). `pull` writes a path-shaped skill to
// `.github/instructions/<slug>.instructions.md` at the repo root INSTEAD OF a SKILL.md, because Copilot
// decides where they live. The SKILL.md scan below never sees one: wrong location (this scans
// `--dir`) and wrong filename. They carry `<!-- bindry:instructions skill=<id> version=<v> -->`, which
// is the same two facts a pin holds, so they are read from the repo root and measured against the
// Binders this run already resolved (readInstructionFiles / judgeInstructionRows below).
//
// THE LIMIT, stated plainly: that marker records the SKILL, not the Binder it was pulled from. A pin
// says `binder=<slug>`, so a SKILL.md is always measured against the right Binder. An instruction file
// can only be matched to a Binder this run found by some OTHER route: a SKILL.md pin in `--dir`. A Binder
// made ONLY of path-shaped skills therefore has nothing to match against, and its files are reported as
// "unchecked", honestly, rather than guessed at. Closing that for good means the API writing the Binder
// into the marker; it is not done here because it changes the file the API produces.
//
// The plugin checkers do not have this limit: they know their one Binder from bindry.config.json.
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
const INSTRUCTIONS_DIR = '.github/instructions';
const INSTRUCTIONS_MARKER = /<!--\s*bindry:instructions\s+skill=(\S+)\s+version=(\S+)\s*-->/;

/** Every Bindry-written instruction file under <root>/.github/instructions, as { file, skill, version }. */
export function readInstructionFiles(root) {
  const dir = join(root, INSTRUCTIONS_DIR);
  if (!existsSync(dir)) return [];

  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.instructions.md')) continue;
    const match = INSTRUCTIONS_MARKER.exec(readFileSync(join(dir, entry.name), 'utf8'));
    // No marker: written by hand, or by something else. Not ours to report on.
    if (!match) continue;
    found.push({ file: `${INSTRUCTIONS_DIR}/${entry.name}`, skill: match[1], version: match[2] });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * One row per instruction file, judged against the Binders this run resolved.
 *
 * `binderStates` is [{ binder, binderVersion, bySkillId }]: for an unpinned Binder its CURRENT
 * composition, for one pulled at a version what THAT version locked (BIND-0257) — the same yardstick
 * the SKILL.md rows use. A skill that appears in several Binders is current if it matches ANY of them,
 * because the marker cannot say which one wrote the file.
 *
 * Rows carry `kind: 'instructions'` so a --json consumer can tell them from the SKILL.md rows, which
 * keep their existing shape.
 */
export function judgeInstructionRows(files, binderStates) {
  return files.map((file) => {
    const base = { kind: 'instructions', file: file.file, skill: file.skill, version: file.version };
    const matches = binderStates.filter((state) => state.bySkillId.has(file.skill));

    if (matches.length === 0) {
      return {
        ...base,
        binder: null,
        binderVersion: null,
        currentVersion: null,
        status: 'unchecked',
        note: binderStates.length === 0
          ? 'no pulled Binder to compare it with (the file records its skill, not its Binder)'
          : "its skill is not in any Binder pulled here (the file records its skill, not its Binder)"
      };
    }

    const exact = matches.find((state) => state.bySkillId.get(file.skill) === file.version);
    if (exact) {
      return { ...base, binder: exact.binder, binderVersion: exact.binderVersion, currentVersion: file.version, status: 'up to date', note: '' };
    }

    const first = matches[0];
    return {
      ...base,
      binder: first.binder,
      binderVersion: first.binderVersion,
      currentVersion: first.bySkillId.get(file.skill),
      status: 'stale',
      note: matches.length > 1 ? `also in ${matches.slice(1).map((state) => state.binder).join(', ')}` : ''
    };
  });
}

async function checkPinnedToVersion({ apiBase, token, binderSlug, binderVersion, binderPins, rows, notices, binderStates }) {
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
  // What this Binder VERSION locked, which is what an instruction file pulled at that version is held to.
  binderStates.push({ binder: binderSlug, binderVersion, bySkillId: lockedBySkillId });

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

export async function check({ apiBase, token, dir, json, root }) {
  // Where Copilot's instruction files live: the repo root, not --dir. cwd in normal use, as in pull.
  const repoRoot = root ?? process.cwd();
  const instructionFiles = readInstructionFiles(repoRoot);
  const binderStates = [];
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
    if (instructionFiles.length > 0) {
      // Only instruction files here (a Binder made entirely of path-shaped skills): nothing to compare
      // them with, and saying so beats saying "no compiled skills".
      const orphanRows = judgeInstructionRows(instructionFiles, binderStates);
      if (json) {
        printJson(orphanRows);
      } else {
        printInstructionRows(orphanRows);
      }
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
      await checkPinnedToVersion({ apiBase, token, binderSlug, binderVersion, binderPins, rows, notices, binderStates });
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
    binderStates.push({ binder: binderSlug, binderVersion: null, bySkillId: currentBySkillId });
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

  const instructionRows = judgeInstructionRows(instructionFiles, binderStates);

  if (json) {
    // Still a flat array. Wrapping it as { skills, binderUpdates } would read better but it is a
    // breaking change to a published CLI's machine contract, and it buys nothing: every row already
    // carries binderVersion and binderLatest, so a CI job can see "a newer Binder version exists"
    // without a shape change or parsing console text.
    // Instruction rows are appended, marked kind: 'instructions'. SKILL.md rows are unchanged, and a repo
    // with no instruction files gets exactly the output it had before.
    printJson([...rows, ...instructionRows]);
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

  printInstructionRows(instructionRows);

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

  const staleInstructions = instructionRows.filter((r) => r.status === 'stale');
  if (staleInstructions.length > 0) {
    console.log(`\n${staleInstructions.length} instruction file(s) do not match what they were pulled at.`);
    for (const row of staleInstructions) {
      const pin = row.binderVersion ? ` --binder-version ${row.binderVersion}` : '';
      console.log(`  ${row.file}: run "bindry pull ${row.binder}${pin}" to refresh it.`);
    }
    // A pull writes files; it does not remove one. A skill that is no longer matched by path leaves its
    // old file behind, and re-pulling cannot clear it, so say so rather than send them round in a circle.
    console.log('  A skill that is no longer matched by path leaves its old file behind; delete that one.');
    process.exitCode = 1;
  }
}

/** Prints the instruction-file table, in its own section: "this rule applies by path" is a different claim from a pinned skill. */
function printInstructionRows(rows) {
  if (rows.length === 0) return;
  console.log('\nPath-matched instruction files (applied by file path, not chosen by the agent):');
  printTable(rows, [
    { header: 'FILE', value: (r) => r.file },
    { header: 'BINDER', value: (r) => r.binder ?? '-' },
    { header: 'SKILL', value: (r) => r.skill },
    { header: 'PINNED', value: (r) => r.version ?? '-' },
    { header: 'EXPECTED', value: (r) => r.currentVersion ?? '-' },
    { header: 'STATUS', value: (r) => r.status },
    { header: 'NOTE', value: (r) => r.note }
  ]);
}
