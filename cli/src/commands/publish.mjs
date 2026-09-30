import { readSourceFolder, SOURCE_DIR } from '../source/format.mjs';
import { detectSourceRef } from '../source/gitref.mjs';
import { publishFromSource } from '../api.mjs';

/**
 * Pushes a repository's rules folder to a Stack (BIND-0197) — the CI half of letting a project keep its
 * rules in its own repo, reviewed in the same PR as the code they describe.
 *
 * Reconciliation is the server's job: this reads the folder, sends it whole, and reports what came back.
 * Deliberately so — deciding locally what changed would mean the CLI and the API each holding an opinion
 * about Binding identity, and the one that is wrong would be the one that quietly re-versions everything.
 */
export async function publish({ apiBase, token, dir, publish: publishStack, stackVersion, changelog, repository, revision, takeOwnership, dryRun, json } = {}) {
  const folder = readSourceFolder(dir ?? SOURCE_DIR);

  if (folder.bindings.length === 0) {
    throw new Error(
      `no Binding documents in ${folder.root}/bindings. Refusing to publish an empty folder — that is far more ` +
      `often a wrong path or a failed checkout than a deliberate removal of every rule.`
    );
  }

  const detected = detectSourceRef(folder.root);
  const sourceRef = {
    repository: repository ?? detected.repository,
    revision: revision ?? detected.revision
  };

  if (!sourceRef.repository) {
    throw new Error(
      'could not tell which repository this is. Pass --repository <host/owner/name> (in GitHub Actions this is ' +
      'detected from GITHUB_REPOSITORY, and locally from git remote origin).'
    );
  }

  if (publishStack && !stackVersion) {
    throw new Error('--publish needs --stack-version <v>: the version to publish the Stack as.');
  }

  const payload = {
    sourceRef,
    stack: folder.stack,
    bindings: folder.bindings,
    publish: Boolean(publishStack),
    stackVersion: stackVersion ?? '',
    changelog: changelog ?? '',
    adoptExisting: Boolean(takeOwnership)
  };

  if (dryRun) {
    return report({ json, folder, sourceRef, payload, dryRun: true });
  }

  if (!token) {
    throw new Error('not logged in. Set BINDRY_API_TOKEN to a workspace API key (how a CI job authenticates), or run "bindry login".');
  }

  const result = await publishFromSource(apiBase, token, payload);
  return report({ json, folder, sourceRef, result });
}

function report({ json, folder, sourceRef, payload, result, dryRun }) {
  if (json) {
    console.log(JSON.stringify(dryRun
      ? { event: 'publish_preview', root: folder.root, sourceRef, payload, problems: folder.problems }
      : { event: 'publish_finished', root: folder.root, sourceRef, result, problems: folder.problems }));
    return result ?? payload;
  }

  for (const problem of folder.problems) {
    console.log(`  - ${problem.path} (${problem.reason})`);
  }

  if (dryRun) {
    if (payload.adoptExisting) {
      console.log('bindry: --take-ownership is set: an existing app-authored Stack or Binding with these slugs would become read-only in Bindry.');
    }
    console.log(`bindry: would publish ${payload.bindings.length} Binding document(s) from ${folder.root}`);
    console.log(`bindry: to Stack "${payload.stack.slug}", recorded as coming from ${describe(sourceRef)}.`);
    for (const document of payload.bindings) {
      console.log(`  + ${document.binding.slug}  (${document.path})`);
    }
    console.log(payload.publish
      ? `bindry: would publish the Stack as ${payload.stackVersion}. Nothing was sent.`
      : 'bindry: would stage the Stack without publishing. Nothing was sent.');
    return payload;
  }

  for (const outcome of result.bindings) {
    console.log(`  ${symbolFor(outcome.action)} ${outcome.slug}${outcome.version ? ` @ ${outcome.version}` : ''}` +
      `${outcome.message ? ` — ${outcome.message}` : ''}`);
  }

  if (result.adoptedStack) {
    // Not reversible by re-running, so it gets its own line rather than a flag buried in the counts.
    console.log('');
    console.log(`bindry: this repository has taken over authorship of "${result.stackSlug}". It is now read-only in Bindry.`);
  }

  for (const removal of result.removed) {
    console.log(`  - ${removal.slug} — no longer in the folder. Dropped from the Stack; the Binding itself is untouched.`);
  }

  const failed = result.bindings.filter((outcome) => outcome.action === 'failed');
  const changed = result.bindings.filter((outcome) => outcome.action === 'created' || outcome.action === 'updated');

  console.log('');
  console.log(`bindry: ${describeCounts(result)} in Stack "${result.stackSlug}" from ${describe(sourceRef)}.`);

  if (result.publishedVersion) {
    console.log(`bindry: published as ${result.publishedVersion}.`);
  } else if (failed.length > 0) {
    console.log('bindry: not published — fix the failed document(s) above first. A rules set with a rule missing is worse than one that did not update.');
  } else {
    console.log('bindry: staged, not published. Publish it in Bindry, or re-run with --publish --stack-version <v>.');
  }

  if (failed.length > 0) {
    // A CI job has to fail on this, or a broken rules file lands silently and nobody looks at the log.
    process.exitCode = 1;
  } else if (changed.length === 0 && result.removed.length === 0) {
    console.log('bindry: nothing changed, so no new versions were minted.');
  }

  return result;
}

function describeCounts(result) {
  const parts = [];
  const count = (action) => result.bindings.filter((outcome) => outcome.action === action).length;
  for (const [action, label] of [['created', 'created'], ['updated', 'updated'], ['unchanged', 'unchanged'], ['failed', 'failed']]) {
    const total = count(action);
    if (total > 0) parts.push(`${total} ${label}`);
  }
  if (result.removed.length > 0) parts.push(`${result.removed.length} dropped`);
  return parts.length === 0 ? 'nothing to do' : parts.join(', ');
}

function describe(sourceRef) {
  return sourceRef.revision ? `${sourceRef.repository}@${sourceRef.revision.slice(0, 7)}` : sourceRef.repository;
}

function symbolFor(action) {
  if (action === 'created') return '+';
  if (action === 'updated') return '~';
  if (action === 'failed') return '!';
  return '=';
}
