import { listMyStacks, BindryApiError } from '../api.mjs';
import { readConfig } from '../config.mjs';

// No dedicated identity endpoint accepts an API key today (see BIND-0175's scoping notes — plain
// [Authorize] endpoints like /api/me/profile only accept a signed-in session, not X-Api-Key).
// Listing Stacks is cheap, already needed elsewhere, and proves the token resolves to a real
// workspace, so it doubles as the identity check.
export async function whoami({ apiBase, token, json } = {}) {
  if (!token) {
    if (json) {
      emit({ event: 'whoami', loggedIn: false, apiBase });
    } else {
      console.log('bindry: not logged in. Run "bindry login" to connect this machine.');
    }
    // Not an error: asking "am I logged in" and being told no is a successful answer.
    return;
  }

  const stored = readConfig();

  try {
    const stacks = await listMyStacks(apiBase, token);

    if (json) {
      emit({
        event: 'whoami',
        loggedIn: true,
        apiBase,
        tenantId: stored.tenantId ?? null,
        stacks: stacks.length
      });
      return;
    }

    console.log(`bindry: logged in against ${apiBase}.`);
    if (stored.tenantId) console.log(`bindry: workspace ${stored.tenantId}.`);
    console.log(`bindry: token is valid — ${stacks.length} Stack${stacks.length === 1 ? '' : 's'} visible in this workspace.`);
  } catch (err) {
    if (err instanceof BindryApiError) {
      if (json) {
        emit({ event: 'whoami', loggedIn: false, apiBase, error: err.message });
        process.exitCode = 1;
        return;
      }
      throw new Error(err.message);
    }
    throw err;
  }
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}
