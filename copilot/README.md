# Bindry plugin for GitHub Copilot (placeholder)

**Status: placeholder — manifest schema not yet confirmed.** Unlike the Claude Code and Codex plugins, I
haven't found GitHub's exact plugin manifest format/directory layout in public docs yet, so there's no
`plugin.json`-equivalent here. This directory is a placeholder until that's nailed down.

## What's confirmed

- Copilot has six customization primitives: agents, skills, hooks, plugins, extensions, and instruction files.
- A community plugin marketplace exists ("awesome-copilot") with 175+ agents, 200+ skills, 48+ plugins.
- Installing from a marketplace: `copilot plugin install <plugin-name>@<marketplace-name>` from the Copilot
  CLI, or `/plugin marketplace browse <marketplace-name>` inside a Copilot session, or via VS Code's
  `@agentPlugins` search / Command Palette → "Chat: Plugins".
- The default `awesome-copilot` marketplace needs no setup — but the exact command to register a *custom*
  marketplace (the local/personal one Bindry would need for testing, equivalent to
  `claude plugin marketplace add <path>` or `codex plugin marketplace add <path>`) wasn't in the docs I checked.

## Open questions before this becomes real

- The custom-marketplace-add command/config for Copilot (needed to test a local, unpublished plugin at all).
- Manifest file name, required fields, and directory layout for a Copilot plugin.
- Whether Copilot skills use the same `SKILL.md` frontmatter convention as Claude Code and Codex, or something
  else — "skills" is named as a primitive but the file format isn't confirmed.

See `Bindry.Plugins/claude-code/README.md` and `Bindry.Plugins/codex/README.md` for the two reference
implementations this will eventually mirror, once the above is confirmed.
