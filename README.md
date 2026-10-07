# Bindry.Plugins

**[Bindry](https://bindry.ai) is a package manager for AI agent skills — version controlled, CLI accessible,
and loaded just in time.** Your skills live in Binders, and your agent takes one out at the moment the task
calls for it, so a turn carries the instructions it needs instead of everything you own. Shorter turns, smaller
bills. Share a Binder privately with your team, or publish it for anyone.

**Pro and Team** keep Binders and skills private to your team, scan every one of them for trust and security,
and generate skills and Binder prompts agentically instead of writing them from scratch.

---

This repo is how a Binder reaches your agent: it compiles a bound Binder into agent skills for whichever coding
agent you use — one plugin per platform, sharing the same compiler logic where the underlying skill format
matches.

| Platform | Status | Docs |
|---|---|---|
| Claude Code | Built, verified end-to-end | [claude-code/](claude-code/) |
| Codex CLI | Built, verified end-to-end | [codex/](codex/) |
| GitHub Copilot | Built — install verified against the real CLI; agent run and live mode not yet verified | [copilot/](copilot/) |
| Terminal (any tool, any CI) | Built, verified end-to-end — public routes against production, private/login paths against a real workspace and key | [cli/](cli/) |

Each subdirectory is a self-contained plugin for its platform — see its own README for install and usage. The
three coding-agent plugins ship a pinned (compiled snapshot) and a live (always current via MCP) sync mode from
one install — the user picks per Binder. `cli/` is the platform-agnostic terminal client (`npm install -g
bindry`) — same pinned/live modes, same compiled output, for scripting, CI, or any agent without its own
plugin.

They also install **public** Binders, not just your own: pass a Library slug with no token and the compiler
resolves it through `GET /api/public/catalog/binders/{slug-or-guid}/export/file`, which is anonymous. A key is
only needed for private Binders. See [claude-code/README.md](claude-code/README.md#installing-someone-elses-binder).

The marketplace manifests live at this repo's root, which is why every install starts with
`<cli> plugin marketplace add bindryai/Plugins` rather than a path into a subdirectory:

- `.claude-plugin/marketplace.json` → `./claude-code` (Claude Code)
- `.github/plugin/marketplace.json` → `./copilot` (GitHub Copilot — Copilot reads the Claude manifest too, but
  prefers this one when both exist)
- `codex/.agents/plugins/marketplace.json` → `./codex` (Codex)

## Development

`node scripts/validate.mjs` (also run in CI on every push/PR) checks that every plugin's manifests and
skill/command frontmatter are well-formed, compiles the bundled example Binders through every compiler as a
regression smoke test, and verifies the generated script copies haven't drifted. Run it before pushing.

**Editing the compiler or drift checker:** `claude-code/scripts/compile-binder.mjs` and
`claude-code/scripts/check-drift.mjs` are the source of truth. Each plugin has to bundle its own copy —
installed plugins live at independent, versioned cache paths per platform with no shared filesystem layout to
import from — so after editing either one run:

```bash
node scripts/sync-compilers.mjs
```

That regenerates the Codex and Copilot copies by re-applying a short, explicit list of platform deltas (output
directory, connect-command wording) rather than a hand-patch. `validate.mjs` runs the same transform in
check-only mode and fails if a committed copy doesn't match, so they can't silently diverge. Adding another
platform means adding an entry to `PLATFORMS` in that script, not forking a copy by hand.
