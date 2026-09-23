import { listMyStacks, BindryApiError } from '../api.mjs';

// No dedicated identity endpoint accepts an API key today (see BIND-0175's scoping notes — plain
// [Authorize] endpoints like /api/me/profile only accept a signed-in session, not X-Api-Key).
// Listing Stacks is cheap, already needed elsewhere, and proves the token resolves to a real
// workspace, so it doubles as the identity check.
export async function whoami({ apiBase, token }) {
  if (!token) {
    console.log('bindry: not logged in. Run "bindry login <token>" first.');
    return;
  }

  try {
    const stacks = await listMyStacks(apiBase, token);
    console.log(`bindry: logged in against ${apiBase}.`);
    console.log(`bindry: token is valid — ${stacks.length} Stack${stacks.length === 1 ? '' : 's'} visible in this workspace.`);
  } catch (err) {
    if (err instanceof BindryApiError) {
      throw new Error(err.message);
    }
    throw err;
  }
}
