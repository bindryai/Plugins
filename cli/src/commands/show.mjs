import { resolveStackDetail, resolveBindingDetail, BindryApiError } from '../api.mjs';
import { printJson } from '../output.mjs';

// GET /api/stacks/{id} returns { stack, bindings }; the public equivalent returns
// { listing, bindings } (the catalog listing standing in for the Stack record — see
// PublicStackDetail's own remarks in Bindry.API for why it's not the raw entity). Same split for a
// Binding: a flat entity when it's yours, { listing } when it's public. This is the one place that
// difference needs to disappear, so every other command and --json's raw passthrough don't have to
// care which shape they got.
function normalizeStack(detail) {
  const core = detail.stack ?? detail.listing ?? detail;
  return {
    title: core.title,
    slug: core.slug,
    // sourceId wins when both exist: for a public listing, "id" is the catalog row's own id, not
    // the underlying Stack's — sourceId is the one that's actually usable as a Stack identifier.
    id: core.sourceId ?? core.id,
    currentVersion: core.currentVersion,
    summary: core.summary,
    bindings: (detail.bindings ?? []).map((b) => ({
      title: b.bindingTitle,
      slug: b.bindingSlug,
      version: b.pinnedVersion
    }))
  };
}

function normalizeBinding(detail) {
  const core = detail.listing ?? detail;
  return {
    title: core.title,
    slug: core.slug,
    id: core.sourceId ?? core.id,
    currentVersion: core.currentVersion,
    summary: core.summary,
    bindings: null
  };
}

// One Stack or Binding's full detail, by slug (public Library) or GUID (yours, if logged in — falls
// back to public automatically, same rule the plugin compilers already use). Doesn't know up front
// whether the identifier names a Stack or a Binding, so it tries Stack first, then Binding — a
// second request only on a 404, which is the uncommon path.
export async function show({ apiBase, token, id, json }) {
  let kind;
  let source;
  let raw;
  try {
    ({ source, detail: raw } = await resolveStackDetail(apiBase, token, id));
    kind = 'Stack';
  } catch (err) {
    if (!(err instanceof BindryApiError) || err.status !== 404) throw err;
    try {
      ({ source, detail: raw } = await resolveBindingDetail(apiBase, token, id));
      kind = 'Binding';
    } catch (bindingErr) {
      if (bindingErr instanceof BindryApiError && bindingErr.status === 404) {
        throw new Error(`no Stack or Binding "${id}" found (checked your workspace and the public Library).`);
      }
      throw bindingErr;
    }
  }

  if (json) {
    printJson(raw);
    return;
  }

  const view = kind === 'Stack' ? normalizeStack(raw) : normalizeBinding(raw);
  console.log(`${kind}: ${view.title ?? view.slug}  (${source})`);
  console.log(`  slug:     ${view.slug ?? ''}`);
  console.log(`  id:       ${view.id ?? ''}`);
  console.log(`  version:  ${view.currentVersion ?? ''}`);
  if (view.summary) console.log(`  summary:  ${view.summary}`);
  if (view.bindings) {
    console.log(`  bindings: ${view.bindings.length}`);
    for (const b of view.bindings) console.log(`    - ${b.title ?? b.slug} (${b.version ?? '?'})`);
  }
  console.log('\n(use --json for the full record)');
}
