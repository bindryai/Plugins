import { searchPublicCatalog } from '../api.mjs';
import { printJson, printTable } from '../output.mjs';

// The public Library, no login required — the CLI's answer to "npm search" / Skills.sh's browse.
export async function search({ apiBase, query, kind, category, tags, skip, take, json }) {
  const result = await searchPublicCatalog(apiBase, { q: query, kind, category, tags, skip, take });
  if (json) {
    printJson(result);
    return;
  }
  printTable(result.items ?? [], [
    { header: 'KIND', value: (item) => item.kind },
    { header: 'SLUG', value: (item) => item.slug },
    { header: 'TITLE', value: (item) => item.title },
    { header: 'CATEGORY', value: (item) => item.category },
    { header: 'VERSION', value: (item) => item.currentVersion }
  ]);
  const total = result.total ?? result.items?.length ?? 0;
  console.log(`\n${result.items?.length ?? 0} of ${total} result${total === 1 ? '' : 's'}.`);
}
