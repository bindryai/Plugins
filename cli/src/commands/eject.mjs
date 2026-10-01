import { getMyBinder, getMySkill, listMyBinders, GUID_PATTERN } from '../api.mjs';
import { writeSourceFolder, binderDocumentFrom, skillDocumentFrom, SOURCE_DIR } from '../source/format.mjs';

/**
 * A Binder id from a GUID or a slug. There is no workspace get-by-slug route, so a slug is resolved by
 * listing the workspace's own Binders — which is also the only way to give a useful error when the slug
 * belongs to somebody else's published Binder rather than to yours.
 */
async function resolveOwnBinderIdAsync(apiBase, token, id) {
  if (GUID_PATTERN.test(id)) return id;

  const slug = id.trim().toLowerCase();
  const mine = await listMyBinders(apiBase, token);
  const match = mine.find((binder) => (binder.slug ?? '').toLowerCase() === slug);
  if (match) return match.id;

  throw new Error(
    `no Binder with slug "${id}" in your workspace. Ejecting reads the full authored content, so it only ` +
    `works on a Binder you own — "bindry list" shows which those are.`
  );
}

/**
 * Writes a rules folder from a Binder you already own (BIND-0197) — the way a team that authored in Bindry
 * moves to authoring in their repo, and the other half of the round trip `bindry publish` reads back.
 *
 * Reads the workspace routes, not the public export: the public export carries what a consumer needs to
 * compile skills, not every field an author owns (no summary, category, tags, examples or targets), so
 * ejecting from it would silently drop half of each Skill and the next publish would erase it upstream.
 */
export async function eject({ apiBase, token, id, out, json } = {}) {
  if (!token) {
    throw new Error('not logged in. Ejecting reads the full Skill content from your workspace, which needs a key.');
  }

  // Always the workspace route, never the public one: you eject a Binder you own, and a Binder that is
  // staged rather than published has no public listing at all — which is exactly the state a team is in
  // when they decide to move authoring into their repo.
  const detail = await getMyBinder(apiBase, token, await resolveOwnBinderIdAsync(apiBase, token, id));
  const binder = detail.binder;
  if (!binder) {
    throw new Error(`could not read Binder "${id}" — it resolved to something without Binder metadata.`);
  }

  const composition = detail.skills ?? [];
  if (composition.length === 0) {
    throw new Error(`Binder "${id}" has no Skills, so there is nothing to eject.`);
  }

  const skills = [];
  const problems = [];
  for (const item of composition) {
    const skillId = item.skillId ?? item.SkillId;
    if (!skillId || !GUID_PATTERN.test(skillId)) {
      problems.push({ slug: item.skillSlug ?? '(unknown)', reason: 'no Skill id in the Binder composition' });
      continue;
    }

    try {
      skills.push(skillDocumentFrom(await getMySkill(apiBase, token, skillId)));
    } catch (err) {
      // One unreadable Skill must not produce a folder that looks complete but is missing a rule — the
      // next publish would read that folder as "this rule was deleted".
      problems.push({ slug: item.skillSlug ?? skillId, reason: err.message });
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `could not read ${problems.length} of ${composition.length} Skills, so the folder would be incomplete: ` +
      problems.map((problem) => `${problem.slug} (${problem.reason})`).join('; ')
    );
  }

  const written = writeSourceFolder(out ?? SOURCE_DIR, { binder: binderDocumentFrom(binder), skills });

  if (json) {
    console.log(JSON.stringify({ event: 'ejected', root: written.root, written: written.written }));
    return written;
  }

  console.log(`bindry: wrote ${skills.length} Skill document(s) for "${binder.title ?? binder.slug}" into ${written.root}`);
  for (const path of written.written) console.log(`  + ${path}`);
  console.log('');
  console.log('bindry: commit this folder, then push it back with:');
  console.log('bindry:   bindry publish --take-ownership');
  console.log('bindry: --take-ownership is needed once, and only once: it hands authorship of this Binder and its');
  console.log('bindry: Skills to the repository, after which they are read-only in Bindry and later pushes need no flag.');
  return written;
}
