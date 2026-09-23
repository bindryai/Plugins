import { listMyStacks } from '../api.mjs';
import { printJson, printTable } from '../output.mjs';

// Your workspace's own Stacks — requires `bindry login` first. For the public Library, use
// `bindry search` instead; this and that are deliberately separate commands, not one with a flag,
// because "mine" and "everyone's" answer different questions and shouldn't be easy to mix up.
export async function list({ apiBase, token, includeArchived, json }) {
  if (!token) {
    throw new Error('not logged in. Run "bindry login <token>" first — this lists your own workspace\'s Stacks.');
  }

  const stacks = await listMyStacks(apiBase, token, { includeArchived });
  if (json) {
    printJson(stacks);
    return;
  }
  printTable(stacks, [
    { header: 'ID', value: (s) => s.id },
    { header: 'SLUG', value: (s) => s.slug },
    { header: 'TITLE', value: (s) => s.title },
    { header: 'STATUS', value: (s) => s.status },
    { header: 'VERSION', value: (s) => s.currentVersion }
  ]);
}
