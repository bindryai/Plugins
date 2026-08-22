# Bindry.Plugins

Compiles a bound [Bindry](https://bindry.ai) Stack into agent skills for whichever coding agent you use — one
plugin per platform, sharing the same compiler logic where the underlying skill format matches.

| Platform | Status | Docs |
|---|---|---|
| Claude Code | Built, verified end-to-end | [claude-code/](claude-code/) |
| Codex CLI | Manifest scaffolded, compiler not yet ported | [codex/](codex/) |
| GitHub Copilot | Placeholder — manifest format unconfirmed | [copilot/](copilot/) |

Each subdirectory is a self-contained plugin for its platform — see its own README for install and usage.

The Claude Code marketplace manifest lives at this repo's root (`.claude-plugin/marketplace.json`), pointing
at `./claude-code` — that's why installing it is `claude plugin marketplace add MedPACTech/Bindry.Plugins`,
not a path into the subdirectory. See [claude-code/README.md](claude-code/README.md) for the full install steps.
