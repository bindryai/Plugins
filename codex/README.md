# Bindry plugin for Codex CLI (placeholder)

**Status: placeholder.** The manifest below is real (verified against OpenAI's Codex plugin docs), but the
compile step isn't ported yet — this directory exists so the shape is settled before we build the logic.

## What's confirmed

- Codex plugins use a manifest at `.codex-plugin/plugin.json` with `name`, `version`, `description`, and a
  `skills` path pointing at a skills directory.
- Skills live at `skills/<skill-name>/SKILL.md`, using the **same frontmatter + Markdown body format** as
  Claude Code skills (`name`, `description`, then instructions in the body). That means the compiler built for
  the Claude Code plugin (`Bindry.Plugins/claude-code/scripts/compile-stack.mjs`) should port to this plugin
  with only the manifest/output-path wrapper changed, not the skill-rendering logic itself.
- A Codex marketplace is a `marketplace.json` — either repo-local at `.agents/plugins/marketplace.json` or
  personal at `~/.agents/plugins/marketplace.json` — listing plugin sources (local path, or a Git URL via
  `git-subdir`).
- Adding a marketplace: `codex plugin marketplace add <owner/repo | git-url | local-path>`. Browsing/installing
  from it happens inside a `codex` session via the `/plugins` command — there's no separate one-shot
  `codex plugin install` shown in the docs the way Claude Code has one.

## Open questions before this becomes real

- Whether to reuse `compile-stack.mjs` directly (parameterize the output shape) or fork it — needs a decision
  once we're ready to build.
- Whether Bindry ships one `marketplace.json` per user (personal) or expects it committed per-repo.
- What `apps`/`mcpServers`/`hooks` (all optional manifest fields) would actually add for a Bindry plugin, if
  anything, versus staying skills-only like the Claude Code plugin.

See `Bindry.Plugins/claude-code/README.md` for the reference implementation this will mirror.
