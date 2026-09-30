import { getMyStack, getMyBinding, listMyStacks, GUID_PATTERN } from '../api.mjs';
import { writeSourceFolder, stackDocumentFrom, bindingDocumentFrom, SOURCE_DIR } from '../source/format.mjs';

/**
 * A Stack id from a GUID or a slug. There is no workspace get-by-slug route, so a slug is resolved by
 * listing the workspace's own Stacks — which is also the only way to give a useful error when the slug
 * belongs to somebody else's published Stack rather than to yours.
 */
async function resolveOwnStackIdAsync(apiBase, token, id) {
  if (GUID_PATTERN.test(id)) return id;

  const slug = id.trim().toLowerCase();
  const mine = await listMyStacks(apiBase, token);
  const match = mine.find((stack) => (stack.slug ?? '').toLowerCase() === slug);
  if (match) return match.id;

  throw new Error(
    `no Stack with slug "${id}" in your workspace. Ejecting reads the full authored content, so it only ` +
    `works on a Stack you own — "bindry list" shows which those are.`
  );
}

/**
 * Writes a rules folder from a Stack you already own (BIND-0197) — the way a team that authored in Bindry
 * moves to authoring in their repo, and the other half of the round trip `bindry publish` reads back.
 *
 * Reads the workspace routes, not the public export: the public export carries what a consumer needs to
 * compile skills, not every field an author owns (no summary, category, tags, examples or targets), so
 * ejecting from it would silently drop half of each Binding and the next publish would erase it upstream.
 */
export async function eject({ apiBase, token, id, out, json } = {}) {
  if (!token) {
    throw new Error('not logged in. Ejecting reads the full Binding content from your workspace, which needs a key.');
  }

  // Always the workspace route, never the public one: you eject a Stack you own, and a Stack that is
  // staged rather than published has no public listing at all — which is exactly the state a team is in
  // when they decide to move authoring into their repo.
  const detail = await getMyStack(apiBase, token, await resolveOwnStackIdAsync(apiBase, token, id));
  const stack = detail.stack;
  if (!stack) {
    throw new Error(`could not read Stack "${id}" — it resolved to something without Stack metadata.`);
  }

  const composition = detail.bindings ?? [];
  if (composition.length === 0) {
    throw new Error(`Stack "${id}" has no Bindings, so there is nothing to eject.`);
  }

  const bindings = [];
  const problems = [];
  for (const item of composition) {
    const bindingId = item.bindingId ?? item.BindingId;
    if (!bindingId || !GUID_PATTERN.test(bindingId)) {
      problems.push({ slug: item.bindingSlug ?? '(unknown)', reason: 'no Binding id in the Stack composition' });
      continue;
    }

    try {
      bindings.push(bindingDocumentFrom(await getMyBinding(apiBase, token, bindingId)));
    } catch (err) {
      // One unreadable Binding must not produce a folder that looks complete but is missing a rule — the
      // next publish would read that folder as "this rule was deleted".
      problems.push({ slug: item.bindingSlug ?? bindingId, reason: err.message });
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `could not read ${problems.length} of ${composition.length} Bindings, so the folder would be incomplete: ` +
      problems.map((problem) => `${problem.slug} (${problem.reason})`).join('; ')
    );
  }

  const written = writeSourceFolder(out ?? SOURCE_DIR, { stack: stackDocumentFrom(stack), bindings });

  if (json) {
    console.log(JSON.stringify({ event: 'ejected', root: written.root, written: written.written }));
    return written;
  }

  console.log(`bindry: wrote ${bindings.length} Binding document(s) for "${stack.title ?? stack.slug}" into ${written.root}`);
  for (const path of written.written) console.log(`  + ${path}`);
  console.log('');
  console.log('bindry: commit this folder, then push it back with:');
  console.log('bindry:   bindry publish --take-ownership');
  console.log('bindry: --take-ownership is needed once, and only once: it hands authorship of this Stack and its');
  console.log('bindry: Bindings to the repository, after which they are read-only in Bindry and later pushes need no flag.');
  return written;
}
