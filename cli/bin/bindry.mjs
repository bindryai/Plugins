#!/usr/bin/env node
import { resolveSession } from '../src/config.mjs';
import { BindryApiError } from '../src/api.mjs';
import { login } from '../src/commands/login.mjs';
import { logout } from '../src/commands/logout.mjs';
import { whoami } from '../src/commands/whoami.mjs';
import { search } from '../src/commands/search.mjs';
import { list } from '../src/commands/list.mjs';
import { show } from '../src/commands/show.mjs';
import { pull } from '../src/commands/pull.mjs';
import { check } from '../src/commands/check.mjs';
import { importRules } from '../src/commands/import.mjs';

const HELP = `bindry — the command-line client for Bindry (bindry.ai)

Usage: bindry <command> [arguments] [options]

Commands:
  login <token>        Store a Personal API Key (create one at <site>/api-keys) for private access.
  logout                Remove the stored token.
  whoami                Confirm the stored token works, and against which API.
  search [query]        Search the public Library. --kind Stack|Binding --category <c> --tags <t,..> --json
  list                  List your own workspace's Stacks. Requires login. --include-archived --json
  show <slug-or-id>      Show one Stack or Binding's detail (yours, or public). --json
  pull <slug-or-id>      Pull a Stack into local files. --out <dir> --target skill-bundle|markdown|agents-md --mode pinned|live
  check                 Check locally pulled skills against their Stack's current versions. --dir <dir> --json
  import [path]         Import the instruction files already in a project (.claude/skills,
                        .cursor/rules, .windsurf/rules, .github/instructions) as private draft
                        Bindings. Local files only. --dry-run --json

Global options:
  --api-base <url>      Override the API base (default: https://api.bindry.ai, or $BINDRY_API_BASE).
  --token <key>         Use this token for one call instead of the stored one (or $BINDRY_API_TOKEN).
  -h, --help             Show this help.
  -v, --version          Show the CLI version.
`;

// Flags that are on/off switches — anything else starting with -- consumes the following argument
// as its value (e.g. --out <dir>). Getting this list wrong silently eats the next real argument
// (or, for a flag at the end of argv, silently resolves to undefined and never fires) — --help and
// --version both need to be here for exactly that reason.
const BOOLEAN_FLAGS = new Set(['json', 'includeArchived', 'dryRun', 'help', 'h', 'version', 'v']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') flags.h = true;
    else if (arg === '-v') flags.v = true;
    else if (arg.startsWith('--')) {
      const name = toCamel(arg.slice(2));
      flags[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
    } else positional.push(arg);
  }
  return { flags, positional };
}

function toCamel(kebab) {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const [command, ...rest] = positional;

  if (flags.version || flags.v || command === 'version') {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    console.log(pkg.version);
    return;
  }
  if (flags.help || flags.h || !command) {
    console.log(HELP);
    // Explicitly asking for help is success; running bindry with nothing at all is the usage error.
    process.exitCode = flags.help || flags.h ? 0 : 1;
    return;
  }

  const session = resolveSession({ apiBase: flags.apiBase, token: flags.token });

  switch (command) {
    case 'login':
      return login({ token: rest[0], apiBase: flags.apiBase });
    case 'logout':
      return logout();
    case 'whoami':
      return whoami(session);
    case 'search':
      return search({
        ...session,
        query: rest.join(' '),
        kind: flags.kind,
        category: flags.category,
        tags: flags.tags?.split(','),
        skip: flags.skip,
        take: flags.take,
        json: flags.json
      });
    case 'list':
      return list({ ...session, includeArchived: flags.includeArchived, json: flags.json });
    case 'show':
      if (!rest[0]) throw new Error('usage: bindry show <slug-or-id> [--json]');
      return show({ ...session, id: rest[0], json: flags.json });
    case 'pull':
      if (!rest[0]) throw new Error('usage: bindry pull <slug-or-id> [--out <dir>] [--target skill-bundle|markdown|agents-md] [--mode pinned|live]');
      return pull({ ...session, id: rest[0], out: flags.out, target: flags.target, mode: flags.mode });
    case 'check':
      return check({ ...session, dir: flags.dir, json: flags.json });
    case 'import':
      return importRules({ ...session, path: rest[0], dryRun: flags.dryRun, json: flags.json });
    default:
      console.error(`bindry: unknown command "${command}". Run "bindry --help" for usage.`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const detail = err instanceof BindryApiError ? err.message : err.message ?? String(err);
  console.error(`bindry: ${detail}`);
  process.exitCode = 1;
});
