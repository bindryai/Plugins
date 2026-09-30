import { resolveBinderDetail, resolveSkillDetail, BindryApiError } from '../api.mjs';
import { printJson } from '../output.mjs';

// GET /api/binders/{id} returns { binder, skills }; the public equivalent returns
// { listing, skills } (the catalog listing standing in for the Binder record — see
// PublicBinderDetail's own remarks in Bindry.API for why it's not the raw entity). Same split for a
// Skill: a flat entity when it's yours, { listing } when it's public. This is the one place that
// difference needs to disappear, so every other command and --json's raw passthrough don't have to
// care which shape they got.
function normalizeBinder(detail) {
  const core = detail.binder ?? detail.listing ?? detail;
  return {
    title: core.title,
    slug: core.slug,
    // sourceId wins when both exist: for a public listing, "id" is the catalog row's own id, not
    // the underlying Binder's — sourceId is the one that's actually usable as a Binder identifier.
    id: core.sourceId ?? core.id,
    currentVersion: core.currentVersion,
    summary: core.summary,
    skills: (detail.skills ?? []).map((b) => ({
      title: b.skillTitle,
      slug: b.skillSlug,
      version: b.pinnedVersion
    }))
  };
}

function normalizeSkill(detail) {
  const core = detail.listing ?? detail;
  return {
    title: core.title,
    slug: core.slug,
    id: core.sourceId ?? core.id,
    currentVersion: core.currentVersion,
    summary: core.summary,
    skills: null
  };
}

// One Binder or Skill's full detail, by slug (public Library) or GUID (yours, if logged in — falls
// back to public automatically, same rule the plugin compilers already use). Doesn't know up front
// whether the identifier names a Binder or a Skill, so it tries Binder first, then Skill — a
// second request only on a 404, which is the uncommon path.
export async function show({ apiBase, token, id, json }) {
  let kind;
  let source;
  let raw;
  try {
    ({ source, detail: raw } = await resolveBinderDetail(apiBase, token, id));
    kind = 'Binder';
  } catch (err) {
    if (!(err instanceof BindryApiError) || err.status !== 404) throw err;
    try {
      ({ source, detail: raw } = await resolveSkillDetail(apiBase, token, id));
      kind = 'Skill';
    } catch (skillErr) {
      if (skillErr instanceof BindryApiError && skillErr.status === 404) {
        throw new Error(`no Binder or Skill "${id}" found (checked your workspace and the public Library).`);
      }
      throw skillErr;
    }
  }

  if (json) {
    printJson(raw);
    return;
  }

  const view = kind === 'Binder' ? normalizeBinder(raw) : normalizeSkill(raw);
  console.log(`${kind}: ${view.title ?? view.slug}  (${source})`);
  console.log(`  slug:     ${view.slug ?? ''}`);
  console.log(`  id:       ${view.id ?? ''}`);
  console.log(`  version:  ${view.currentVersion ?? ''}`);
  if (view.summary) console.log(`  summary:  ${view.summary}`);
  if (view.skills) {
    console.log(`  skills: ${view.skills.length}`);
    for (const b of view.skills) console.log(`    - ${b.title ?? b.slug} (${b.version ?? '?'})`);
  }
  console.log('\n(use --json for the full record)');
}
