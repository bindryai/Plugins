# Bindry plugin for Codex CLI

Compiles a bound Bindry Stack into Codex skills — one skill per Binding — so instructions load only when a
task actually matches them, instead of sitting in context on every turn. Same idea as the Claude Code plugin
in this repo, ported to Codex's actual plugin/skill mechanics.

## Install

```bash
codex plugin marketplace add MedPACTech/Bindry.Plugins
codex plugin add bindry@bindry-plugins
```

Verified working end-to-end against the real `@openai/codex` CLI: both commands complete successfully and
`codex plugin list` shows `bindry@bindry-plugins` as `installed, enabled`, with all three skills and both
scripts present under the installed plugin's cache path.

The marketplace manifest lives at `codex/.agents/plugins/marketplace.json` — this is the actual, confirmed
location (found by testing several guesses against the real CLI; **not** `.codex-plugin/marketplace.json`,
which is what a naive port from Claude Code's layout would suggest). The plugin manifest itself,
`.codex-plugin/plugin.json`, points its `skills` field at `./skills/`.

To try a local checkout instead of the published repo, point `marketplace add` at the repo root on disk
(`/path/to/Bindry.Plugins`) — same two commands otherwise.

## Use

Bindry ships three skills, each a near-direct port of the Claude Code plugin's equivalent command — same logic,
adapted to Codex's skill-only invocation model (Codex plugins have no separate "commands" concept; skills,
triggered by description-matching or `$name`, are the only invokable action a plugin can expose):

- **`bindry-sync`** — compile a Bindry Stack into `.agents/skills/` (Codex's project-local skills directory,
  the equivalent of Claude Code's `.claude/skills/`). Supports the same `--mode pinned|live` split described
  below.
- **`bindry-check`** — read-only drift report against the already-compiled skills. Never edits or re-syncs.
- **`bindry-connect`** — one-time, per-machine setup connecting Codex to the Bindry MCP server for live mode.

## Live mode

Same design as the Claude Code plugin: `--mode pinned` (default) compiles a static snapshot; `--mode live`
compiles a pointer skill whose body tells the agent to call the Bindry MCP server's `bindry.bindings.get` tool
for current content instead of trusting anything cached. A live skill never goes stale, so `bindry-check`
reports it as "live (always current)."

Connecting to the MCP server is a deliberate, explicit opt-in via the `bindry-connect` skill — not a bundled
`mcpServers` entry in the plugin manifest. Codex, like Claude Code, has no way to conditionally load a
plugin-declared MCP server; bundling one would put a permanent "not connected" status in front of every
pinned-only installer who hasn't set up an API key.

```bash
codex mcp add bindry --url <api-base>/api/mcp --bearer-token-env-var BINDRY_API_TOKEN
```

The token needs the **`mcp` tool scope** granted specifically (Bindry → Account settings → API keys) — a
different grant than a pinned-mode sync token. Verified live end-to-end: registered a real API key with the
`mcp` scope this way against a real running Bindry API, confirmed `codex mcp get bindry` reports it enabled,
and confirmed (via a real independent MCP client) that `Authorization: Bearer <key>` against `/api/mcp` returns
real tool results — this required a small fix upstream in IBeam's default JWT scheme, which was previously
intercepting any non-JWT Bearer value before the API-key scheme got a chance; see the Bindry-API changelog for
that fix's own verification.

## Try it right now, without Codex

The compiler is the same plain, dependency-free Node script as the Claude Code plugin, just defaulting to a
different output directory:

```bash
# from a local export file
node scripts/compile-stack.mjs examples/git-flow-command-center.stack.json

# a Binding with an attachment (logo file)
node scripts/compile-stack.mjs examples/brand-guidelines.stack.json

# live, from a running Bindry API
node scripts/compile-stack.mjs <stack-id> --api-base http://localhost:5160 --token <api-key> --out .agents/skills
```

Verified against a real running Bindry API: output for the bundled examples is byte-identical to what the
Claude Code compiler produces for the same input (frontmatter, pin/live comment, body, assets — only the output
directory differs), and a full live round-trip (seed a Stack + Binding, compile pinned and live, edit the
Binding's content, re-fetch live and see the new content immediately) was verified the same way it was for the
Claude Code plugin.

## Current limitations

- `--mode live` requires real GUID Binding ids from a live-fetched Stack — the bundled
  `examples/*.stack.json` files use illustrative ids (e.g. `bnd_git_branch_pr_hygiene`), not real GUIDs, so
  those Bindings are skipped with a warning rather than compiling a skill that would always fail.
- Attachments are still downloaded and pinned to disk at compile time even in live mode — the live MCP tool
  returns a Binding's text content only, not its file attachments.
- `/api/stacks/{id}/export` is workspace-scoped, same as the Claude Code plugin — "sync your own Stacks," not
  "install someone else's published Stack."
- Codex skills have no structured "prefer tool X" mechanism beyond the prose in the skill body itself (confirmed
  against a real OpenAI-authored plugin already installed on this machine) — a live skill's instruction to call
  the MCP tool is exactly that: an instruction, not an enforced constraint.
