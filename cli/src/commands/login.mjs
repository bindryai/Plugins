import { writeConfig, readConfig, DEFAULT_API_BASE } from '../config.mjs';
import { listMyStacks, BindryApiError } from '../api.mjs';

// A Personal API Key, not a new credential kind: mint one at bindry.ai/api-keys (Team page) and
// paste it here. No device-code flow to build or maintain — StacksController already accepts this
// same key via the "BindryApi" auth policy, the one the agent plugins use headlessly today.
export async function login({ token, apiBase }) {
  if (!token) {
    throw new Error('usage: bindry login <token> [--api-base <url>]\n  Create a token at <site>/api-keys while signed in to the workspace you want the CLI to use.');
  }

  const resolvedApiBase = apiBase ?? DEFAULT_API_BASE;

  let stacks;
  try {
    stacks = await listMyStacks(resolvedApiBase, token);
  } catch (err) {
    if (err instanceof BindryApiError) {
      throw new Error(`could not verify that token: ${err.message}`);
    }
    throw err;
  }

  writeConfig({ ...readConfig(), apiBase: resolvedApiBase, token });
  console.log(`bindry: logged in. ${stacks.length} Stack${stacks.length === 1 ? '' : 's'} in this workspace.`);
  console.log(`bindry: API base set to ${resolvedApiBase}.`);
}
