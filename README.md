# Bindry.Plugins

Compiles a bound [Bindry](https://bindry.ai) Stack into agent skills for whichever coding agent you use — one
plugin per platform, sharing the same compiler logic where the underlying skill format matches.

| Platform | Status | Docs |
|---|---|---|
| Claude Code | Built, verified end-to-end | [claude-code/](claude-code/) |
| Codex CLI | Built, verified end-to-end | [codex/](codex/) |
| GitHub Copilot | Not built — manifest format unconfirmed. Use the `AGENTS.md` export instead. | [copilot/](copilot/) |

Each subdirectory is a self-contained plugin for its platform — see its own README for install and usage. Both
Claude Code and Codex ship a pinned (compiled snapshot) and a live (always current via MCP) sync mode from one
install — the user picks per Stack.

Both also install **public** Stacks, not just your own: pass a marketplace slug with no token and the compiler
resolves it through `GET /api/public/catalog/stacks/{slug-or-guid}/export/file`, which is anonymous. A key is
only needed for private Stacks. See [claude-code/README.md](claude-code/README.md#installing-someone-elses-stack).

The Claude Code marketplace manifest lives at this repo's root (`.claude-plugin/marketplace.json`), pointing
at `./claude-code` — that's why installing it is `claude plugin marketplace add bindryai/Plugins`,
not a path into the subdirectory. See [claude-code/README.md](claude-code/README.md) for the full install steps.

## Development

`node scripts/validate.mjs` (also run in CI on every push/PR) checks that both plugins' manifests and skill/command
frontmatter are well-formed, compiles the bundled example Stacks through both compilers as a regression smoke
test, and verifies the two compiler copies haven't drifted. Run it before pushing.

**Editing the compiler:** `claude-code/scripts/compile-stack.mjs` is the source of truth. Each plugin has to
bundle its own copy — installed plugins live at independent, versioned cache paths per platform with no shared
filesystem layout to import from — so after editing it run:

```bash
node scripts/sync-codex-compiler.mjs
```

That regenerates the Codex copy by re-applying a short, explicit list of platform deltas (output directory,
connect-command wording) rather than a hand-patch. `validate.mjs` runs the same transform in check-only mode and
fails if the committed copy doesn't match, so the two can't silently diverge. Adding a third platform means
adding its deltas to that list, not forking a third copy by hand.
