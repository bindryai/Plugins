# bindry — the Bindry CLI

The terminal client for [Bindry](https://bindry.ai): search the public Library, pull a Stack into local files,
and check whether what's on disk has drifted from what's actually published — all from a script or a shell,
no browser required.

## What it does

- **`search`** — the public Library, by free-text query, kind, category, or tags. No login needed.
- **`list`** — your own workspace's Stacks. Needs `bindry login` first.
- **`show <slug-or-id>`** — one Stack or Binding's detail, yours or public, human-readable or `--json`.
- **`pull <slug-or-id>`** — compiles a Stack, or a standalone Binding, to local files: one `SKILL.md` per Binding
  by default (the same format and `bindry:pin` comment the Claude Code and Codex plugins already produce and
  read), or a single Markdown/AGENTS.md file with `--target`. Tries Stack resolution first, falls back to a
  Binding on a real not-found.
- **`check`** — read-only: compares every locally pulled skill's pinned version against its Stack's (or, for a
  standalone Binding, its own) current version, and reports stale/up to date/unknown. Never re-pulls or edits
  anything for you.

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

```bash
bindry login
```

That prints a short code, opens `bindry.ai/device`, and waits. Approve the code there — signing up first if
you have no account yet — and the terminal collects a workspace key of its own. Nothing is pasted, and nothing
secret travels by email.

Signing **up** deliberately happens in the browser: terms have to be shown and agreed to, and the usual
anti-abuse checks need a real page. A terminal can do neither.

The key it ends up with is an ordinary Personal API Key — the same credential the Claude Code, Codex and
Copilot plugins use for headless sync — scoped to the one workspace you approved it for. It lands in
`~/.bindry/config.json` (0600 where the platform supports it), and it shows up on that workspace's Team page
like any other key.

```bash
bindry logout            # revokes the key, then forgets it
bindry logout --keep-key # forgets it locally, leaves it working (e.g. shared with CI)
```

**In CI, or anywhere without a browser:** pass a key you already made, or set `BINDRY_API_TOKEN`.

```bash
bindry login <token>          # verify and store a key you already have
bindry login --no-browser     # pair over SSH: the URL is printed, open it wherever you can
BINDRY_API_TOKEN=... bindry list   # no login at all — the env var wins for that call
```

**Driving it from an agent or a script:** `login`, `logout` and `whoami` take `--json` and emit one JSON
object per line. `bindry login --json` emits `pairing_started` (with `user_code`, the URL, and a `next_step`
sentence to relay to a human) as soon as it has them, then `logged_in` once approval lands — so an agent can
tell someone what to click and then wait, rather than watching a spinner it cannot see.

Nothing above is required for the public Library: `search`, and `show`/`pull` against a published Stack, work
with no login at all — the CLI tries a token first only when the identifier looks like one of your own
(a GUID), and falls back to the public route automatically otherwise.

## Use

```bash
# Browse the public Library
bindry search "git flow" --kind Stack --json

# Your own workspace — approve this machine in the browser, once
bindry login
bindry list --json

# Pull a Stack — yours by GUID, or anyone's published one by slug
bindry pull git-flow-command-center --out .claude/skills
bindry pull git-flow-command-center --target markdown --out ./docs

# Pull a single Binding on its own — same rules, no Stack required
bindry pull quick-review-checklist --out .claude/skills

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
- `pull`/`check` on a **standalone Binding** (no Stack at all) were verified against that same fixture server
  only — the public catalog had no published standalone Binding to pull for real at the time this was built.
  The `bindry:pin` comment correctly omits `stack=` entirely for these (rather than fabricating one), and
  `check` correctly resolves such a pin by the Binding's own id instead of trying a Stack lookup.

## Current limitations

- No shell completion, no interactive prompts — every argument is explicit, on purpose, so it stays scriptable.
- `check`'s drift comparison, like the plugins' own `/bindry-check`, can only report "pinned at X, Stack now
  pins Y," not how many versions behind that is — the API doesn't expose a Binding's full version history.
