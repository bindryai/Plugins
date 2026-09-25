import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { scanForInstructionFiles } from '../import/scan.mjs';
import { toBindingDraft } from '../import/parse.mjs';
import { describeGitSource } from '../import/provenance.mjs';
import { createBinding, BindingApiTargets, BindryApiError } from '../api.mjs';

/**
 * Imports the instruction files already in a project as private draft Bindings (BIND-0205).
 *
 * Local disk only — no GitHub App, no OAuth, no webhooks, no stored third-party token. The agent
 * running this is already in the checked-out repo.
 *
 * Structured formats (SKILL.md, .mdc, .instructions.md) parse deterministically: no AI, no credits.
 * Unstructured prose (AGENTS.md, copilot-instructions.md) is reported but not imported here —
 * splitting it into rules is the AI segmentation path, which costs credits and should be offered,
 * not assumed.
 */
export async function importRules({ apiBase, token, path, dryRun, json } = {}) {
  const root = resolve(path ?? process.cwd());

  if (!existsSync(root)) {
    throw new Error(`no such directory: ${root}`);
  }

  if (!token && !dryRun) {
    throw new Error('not logged in. Run "bindry login" first, or use --dry-run to see what would be imported.');
  }

  const found = scanForInstructionFiles(root);
  if (found.length === 0) {
    return report({ json, root, results: [], dryRun, nothingFound: true });
  }

  const provenance = describeGitSource(root);
  const results = [];

  for (const source of found) {
    if (source.skipped) {
      results.push({ file: source.relativePath, status: 'skipped', reason: source.skipped });
      continue;
    }

    if (!source.structured) {
      results.push({
        file: source.relativePath,
        status: 'needs-review',
        reason: 'prose, not one rule per file — import it in the app to have it split into Bindings'
      });
      continue;
    }

    const draft = toBindingDraft(source, { provenance });
    if (!draft) {
      results.push({ file: source.relativePath, status: 'skipped', reason: 'no instructions found in it' });
      continue;
    }

    if (dryRun) {
      results.push({ file: source.relativePath, status: 'would-create', title: draft.title, slug: draft.slug });
      continue;
    }

    try {
      const { created, visibility } = await createWithBestVisibility(apiBase, token, draft);
      results.push({
        file: source.relativePath,
        status: 'created',
        title: draft.title,
        slug: draft.slug,
        id: created.id,
        visibility
      });
    } catch (err) {
      if (!(err instanceof BindryApiError)) throw err;
      // One rejected Binding does not fail the import: a partial result is the normal case, and
      // the file-by-file report is how the user knows which ones need attention.
      results.push({ file: source.relativePath, status: 'failed', title: draft.title, reason: err.message });
    }
  }

  return report({ json, root, results, dryRun, provenance });
}

/**
 * Private if the plan allows it, otherwise a plain draft.
 *
 * Private visibility needs Pro or higher, so on a free workspace the first attempt is rejected
 * outright. A draft is not in the Library either way — visibility only takes effect when something
 * is published — so falling back keeps the import working, and the report says which happened
 * rather than quietly downgrading what the user asked for.
 */
async function createWithBestVisibility(apiBase, token, draft) {
  try {
    return { created: await createBinding(apiBase, token, toRequest(draft, 'Private')), visibility: 'Private' };
  } catch (err) {
    if (!(err instanceof BindryApiError) || !isPlanRestriction(err)) throw err;
    return { created: await createBinding(apiBase, token, toRequest(draft, 'Public')), visibility: 'Draft' };
  }
}

function isPlanRestriction(err) {
  return err.status === 400 && /Pro plan or higher/i.test(err.message);
}

/** The API's BindingDraftRequest. Always a draft — publishing stays a separate deliberate act. */
function toRequest(draft, visibility) {
  return {
    slug: draft.slug,
    title: draft.title,
    summary: draft.summary,
    category: 'Imported',
    visibility,
    audience: [],
    tags: draft.tags,
    scope: { appliesWhen: draft.appliesWhen, doesNotApplyWhen: [] },
    instructions: draft.instructions,
    constraints: [],
    examples: [],
    verificationChecklist: [],
    supportedTargets: BindingApiTargets,
    tokenEstimate: estimateTokens(draft.instructions),
    trust: {
      reviewed: false,
      riskLevel: 'Low',
      provenance: draft.provenance,
      labels: ['Imported']
    }
  };
}

/** The same rough words-to-tokens factor the app uses when it has nothing better. */
function estimateTokens(instructions) {
  const words = instructions.trim().split(/\s+/).filter(Boolean).length;
  const estimated = Math.round(words * 1.4);
  return { estimated, alwaysLoaded: 0, taskLoaded: estimated };
}

function report({ json, root, results, dryRun, provenance, nothingFound }) {
  if (json) {
    console.log(JSON.stringify({ event: dryRun ? 'import_preview' : 'import_finished', root, provenance: provenance ?? null, results }));
    return results;
  }

  if (nothingFound) {
    console.log('bindry: no instruction files found here.');
    console.log('bindry: looked for .claude/skills, .agents/skills, .github/skills, .cursor/rules, .windsurf/rules, .github/instructions, AGENTS.md.');
    return results;
  }

  const created = results.filter((r) => r.status === 'created' || r.status === 'would-create');
  for (const result of results) {
    console.log(`  ${symbolFor(result.status)} ${result.file}${result.title ? ` -> ${result.title}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
  }

  const downgraded = results.filter((r) => r.visibility === 'Draft').length;

  console.log('');
  if (dryRun) {
    console.log(`bindry: ${created.length} Binding${created.length === 1 ? '' : 's'} would be created. Nothing was written.`);
    return results;
  }

  console.log(`bindry: ${created.length} Binding${created.length === 1 ? '' : 's'} created as drafts.`);
  if (downgraded > 0) {
    console.log('bindry: this workspace is on a plan without private Bindings, so they were created as ordinary drafts.');
    console.log('bindry: a draft is not in the public Library either way — upgrade before publishing if these should stay private.');
  }
  console.log('bindry: review and publish them in Bindry when you are ready — nothing is public yet.');
  return results;
}

function symbolFor(status) {
  if (status === 'created' || status === 'would-create') return '+';
  if (status === 'failed') return '!';
  return '-';
}
