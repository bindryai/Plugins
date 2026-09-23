# bindry — the Bindry CLI

The terminal client for [Bindry](https://bindry.ai): search the public Library, pull a Stack into local files,
and check whether what's on disk has drifted from what's actually published — all from a script or a shell,
no browser required.

## What it does

- **`search`** — the public Library, by free-text query, kind, category, or tags. No login needed.
- **`list`** — your own workspace's Stacks. Needs `bindry login` first.
- **`show <slug-or-id>`** — one Stack or Binding's detail, yours or public, human-readable or `--json`.
- **`pull <slug-or-id>`** — compiles a Stack to local files: one `SKILL.md` per Binding by default (the same
  format and `bindry:pin` comment the Claude Code and Codex plugins already produce and read), or a single
  Markdown/AGENTS.md file with `--target`.
- **`check`** — read-only: compares every locally pulled skill's pinned version against the Stack's current one,
  and reports stale/up to date/unknown. Never re-pulls or edits anything for you.

A Stack pulled with this CLI and one synced by the Claude Code or Codex plugin land on disk identically — this
is another output target for the same compiled shape, not a second format to keep in sync by hand.

## Install

```bash
npm install -g bindry
```

or run it without installing anything:

```bash
npx bindry search
```

## Auth

There's no separate account system for the CLI and no device-code flow to walk through. A **Personal API Key**
is the same credential the Claude Code/Codex plugins already use for headless sync — create one from the
workspace's Team page in Bindry (**not** Account settings; a key is scoped to whichever workspace's Team page
you made it from), then:

```bash
bindry login <token>
```

This verifies the token against the API and stores it in `~/.bindry/config.json` (0600 where the platform
supports it) so you don't have to pass it on every call. `bindry logout` removes it locally — that does not
revoke the key itself; do that from the Team page if it may be compromised. `--token <key>` on any single
command, or the `BINDRY_API_TOKEN` environment variable, override the stored one for that call without logging
in at all — useful in CI.

Nothing above is required for the public Library: `search`, and `show`/`pull` against a published Stack, work
with no login at all — the CLI tries a token first only when the identifier looks like one of your own
(a GUID), and falls back to the public route automatically otherwise.

## Use

```bash
# Browse the public Library
bindry search "git flow" --kind Stack --json

# Your own workspace
bindry login <token>
bindry list --json

# Pull a Stack — yours by GUID, or anyone's published one by slug
bindry pull git-flow-command-center --out .claude/skills
bindry pull git-flow-command-center --target markdown --out ./docs

# Live mode: a pointer skill that calls the Bindry MCP server for current content instead of a
# frozen snapshot (needs the MCP server connected separately — see the Claude Code plugin's README)
bindry pull <stack-id> --mode live

# Did anything change since I pulled?
bindry check --dir .claude/skills
```

`--api-base <url>` overrides the API (default `https://api.bindry.ai`, or `$BINDRY_API_BASE`) for pointing at
a local or staging API instead.

## What's actually been verified

- `search`, and `show` on a public slug (including a not-found identifier), were run against the real,
  live production API (`https://api.bindry.ai`) — real 200s, real 404 handling, response shapes matched what's
  documented here.
- `login`, `whoami`, `list`, `show` (by GUID), `pull` (`--target skill-bundle` default, `--mode live`, and
  `--target markdown`), and `check`'s drift comparison were all verified end-to-end against a real workspace on
  `test-api.bindry.ai` with a real Personal API Key: a real Draft Stack with two real Bindings, correct
  private-route resolution by GUID, correct compiled SKILL.md content and pin comments, and `check` correctly
  reporting both Bindings as up to date immediately after a pull.
- `show`/`pull` on a **slug** correctly fail for a private, unpublished (Draft) Stack — a slug alone can't be
  routed to a specific private workspace, only a GUID can (with a token) or a public listing can (with a slug).
  This is the documented, intended behavior, confirmed against the real API, not a gap.
- Also verified end-to-end against a fixture HTTP server shaped exactly like the real controllers
  (`Bindry.API/Controllers/{Stacks,PublicCatalog}Controller.cs`), covering a drift scenario (a pin baked in at
  one version, the server reporting the Binding has since moved to another) reported correctly as stale.

## Current limitations

- `pull` handles Stacks only — there's no `bindry pull` for a standalone Binding yet, even though `show` will
  find one. `bindry.pull` on a Binding slug is a reasonable next command, not built here.
- No shell completion, no interactive prompts — every argument is explicit, on purpose, so it stays scriptable.
- `check`'s drift comparison, like the plugins' own `/bindry-check`, can only report "pinned at X, Stack now
  pins Y," not how many versions behind that is — the API doesn't expose a Binding's full version history.
