# Bindry.Plugins

Compiles a bound [Bindry](https://bindry.ai) Stack into agent skills for whichever coding agent you use — one
plugin per platform, sharing the same compiler logic where the underlying skill format matches.

| Platform | Status | Docs |
|---|---|---|
| Claude Code | Built, verified end-to-end | [claude-code/](claude-code/) |
| Codex CLI | Built, verified end-to-end | [codex/](codex/) |
| GitHub Copilot | Placeholder — manifest format unconfirmed | [copilot/](copilot/) |

Each subdirectory is a self-contained plugin for its platform — see its own README for install and usage. Both
Claude Code and Codex ship a pinned (compiled snapshot) and a live (always current via MCP) sync mode from one
install — the user picks per Stack.

The Claude Code marketplace manifest lives at this repo's root (`.claude-plugin/marketplace.json`), pointing
at `./claude-code` — that's why installing it is `claude plugin marketplace add bindryai/Plugins`,
not a path into the subdirectory. See [claude-code/README.md](claude-code/README.md) for the full install steps.

## Development

`node scripts/validate.mjs` (also run in CI on every push/PR) checks that both plugins' manifests and skill/command
frontmatter are well-formed, and compiles the bundled example Stacks through both compilers as a regression smoke
test. Run it before pushing.
