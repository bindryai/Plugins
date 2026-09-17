# Bindry plugin for GitHub Copilot

Compiles a bound Bindry Stack into GitHub Copilot skills — one skill per Binding — so instructions load only
when a task actually matches them, instead of sitting in context on every turn. Same idea as the Claude Code
and Codex plugins in this repo, ported to Copilot's plugin/skill mechanics.

## Install

```bash
copilot plugin marketplace add bindryai/Plugins
copilot plugin install bindry@bindry-plugins
```

The marketplace manifest lives at the repo root in `.github/plugin/marketplace.json`, listing this plugin at
`source: "./copilot"`. The repo also has a `.claude-plugin/marketplace.json` for Claude Code, which Copilot
*also* reads — confirmed against the real Copilot CLI (v1.0.85) that when both exist, Copilot takes
`.github/plugin/marketplace.json` and installs this plugin, while Claude Code keeps installing `./claude-code`
from its own manifest. Remove the `.github/plugin` file and Copilot would silently install the Claude Code
plugin instead.

The plugin manifest is `copilot/plugin.json` (Copilot's own format, found at the plugin root), with `skills`
pointing at `skills/`.

VS Code's Copilot Chat discovers plugins installed by the Copilot CLI automatically. To add the marketplace
from VS Code alone, add `bindryai/Plugins` to the `chat.plugins.marketplaces` setting.

To try a local checkout instead of the published repo, point `marketplace add` at the repo root on disk
(`/path/to/Bindry.Plugins`) — same two commands otherwise. A local marketplace is loaded live from disk rather
than copied, so edits show up in the next session.

## Use

Bindry ships three skills, each a port of the Codex plugin's equivalent. Copilot skills are invoked by name
with a leading slash in a prompt (`Use /bindry-sync to ...`) or trigger automatically from their description:

- **`/bindry-sync`** — compile a Bindry Stack into `.github/skills/` (Copilot's first project-local skills
  directory; it also reads `.agents/skills/` and `.claude/skills/`). Supports the same `--mode pinned|live`
  split as the other plugins. Run `/skills reload` or start a new session to pick up newly compiled skills.
- **`/bindry-check`** — read-only drift report against the already-compiled skills. Never edits or re-syncs.
- **`/bindry-connect`** — one-time, per-machine setup connecting Copilot to the Bindry MCP server for live mode.

Each skill finds the bundled scripts relative to its own base directory (`../../scripts/`), which Copilot
hands the agent when a skill loads — no install path to hunt for.

## Live mode

Same design as the other plugins: `--mode pinned` (default) compiles a static snapshot; `--mode live` compiles
a pointer skill whose body tells the agent to call the Bindry MCP server's `bindry.bindings.get` tool for
current content. A live skill never goes stale, so `/bindry-check` reports it as "live (always current)."

Connecting is an explicit opt-in via `/bindry-connect`, not a bundled `mcpServers` entry — bundling one would
put a permanent "not connected" server in front of every pinned-only installer who has no API key.

```bash
copilot mcp add --transport http bindry <api-base>/api/mcp --header 'X-Api-Key: ${BINDRY_API_TOKEN}'
```

## Try it right now, without Copilot

```bash
# from a local export file (writes .github/skills/ in the current directory)
node scripts/compile-stack.mjs examples/git-flow-command-center.stack.json

# live, from a running Bindry API
node scripts/compile-stack.mjs <stack-id> --api-base http://localhost:5160 --token <api-key>
```

## What's verified, and what isn't yet

Verified against the real `@github/copilot` CLI v1.0.85, using an isolated `COPILOT_HOME`:

- `marketplace add` on the repo root picks up `.github/plugin/marketplace.json` over the Claude Code manifest,
  and `plugin install bindry@bindry-plugins` reports "Installed 3 skills" and lists the plugin as enabled.
- `copilot mcp add` with the single-quoted header saves the literal `${BINDRY_API_TOKEN}` reference in
  `mcp-config.json`, not the key.
- Compiling the bundled examples produces output byte-identical to the Claude Code compiler, only in
  `.github/skills/`.

**Not yet verified**, because it needs a signed-in Copilot session:

- An agent actually running `/bindry-sync` and `/bindry-check` end to end, including resolving the scripts
  through the skill's base directory.
- Copilot expanding `${BINDRY_API_TOKEN}` in the MCP header when it connects. Expansion of `${VAR}` in
  `mcp-config.json` has regressed in past Copilot CLI releases
  ([github/copilot-cli#1403](https://github.com/github/copilot-cli/issues/1403)), so check this before
  relying on live mode.
- Installing from the published GitHub repo rather than a local checkout, and installing through VS Code.

## Current limitations

- `--mode live` requires real GUID Binding ids from a live-fetched Stack — the bundled
  `examples/*.stack.json` files use illustrative ids, so those Bindings are skipped with a warning.
- Attachments are still downloaded and pinned to disk at compile time even in live mode — the live MCP tool
  returns a Binding's text content only.
