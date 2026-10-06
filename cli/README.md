# bindry — the Bindry CLI

The terminal client for [Bindry](https://bindry.ai): search the public Library, pull a Binder into local files,
and check whether what's on disk has drifted from what's actually published — all from a script or a shell,
no browser required.

## What it does

- **`search`** — the public Library, by free-text query, kind, category, or tags. No login needed.
- **`list`** — your own workspace's Binders. Needs `bindry login` first.
- **`show <slug-or-id>`** — one Binder or Skill's detail, yours or public, human-readable or `--json`.
- **`pull <slug-or-id>`** — compiles a Binder, or a standalone Skill, to local files: one `SKILL.md` per Skill
  by default (the same format and `bindry:pin` comment the Claude Code and Codex plugins already produce and
  read), or a single Markdown/AGENTS.md file with `--target`. Tries Binder resolution first, falls back to a
  Skill on a real not-found.
- **`check`** — read-only: compares every locally pulled skill's pinned version against its Binder's (or, for a
  standalone Skill, its own) current version, and reports stale/up to date/unknown. Never re-pulls or edits
  anything for you.
- **`eject <slug-or-id>`** — writes a Binder you own out as a `.bindry/` folder to commit to your repo: one JSON
  document per Skill, plus `binder.json`. How a team that authored in Bindry moves to authoring in their repo.
- **`publish [dir]`** — pushes that folder back. The server reconciles it: new Skills are created, changed ones
  get a new version, identical ones are left alone, and ones the folder no longer has are reported rather than
  deleted. Built for CI, and safe to run on every commit — an unchanged folder mints no versions.

A Binder pulled with this CLI and one synced by the Claude Code or Codex plugin land on disk identically — this
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

Nothing above is required for the public Library: `search`, and `show`/`pull` against a published Binder, work
with no login at all — the CLI tries a token first only when the identifier looks like one of your own
(a GUID), and falls back to the public route automatically otherwise.

## Use

```bash
# Browse the public Library
bindry search "git flow" --kind Binder --json

# Your own workspace — approve this machine in the browser, once
bindry login
bindry list --json

# Pull a Binder — yours by GUID, or anyone's published one by slug
bindry pull git-flow-command-center --out .claude/skills
bindry pull git-flow-command-center --target markdown --out ./docs

# Pull a single Skill on its own — same rules, no Binder required
bindry pull quick-review-checklist --out .claude/skills

# Live mode: a pointer skill that calls the Bindry MCP server for current content instead of a
# frozen snapshot (needs the MCP server connected separately — see the Claude Code plugin's README)
bindry pull <binder-id> --mode live

# Did anything change since I pulled?
bindry check --dir .claude/skills

# Move a Binder you own into your repo, then push changes back from there
bindry eject my-binder-slug              # writes .bindry/
bindry publish --dry-run                # see what would be sent, no key needed
bindry publish --take-ownership         # first push only: the repo becomes the source of truth
bindry publish                          # every push after that
bindry publish --publish --binder-version 2.1.0   # and cut a Binder version while you are at it
```

## Publishing a repo's rules from CI

The folder `eject` writes is the format `publish` reads:

```
.bindry/
  binder.json                          the Binder's own metadata
  skills/<slug>.json                one Skill per file
```

A Skill document's fields are the same ones the app authors, so the round trip is lossless — verified by
ejecting a Binder and pushing the folder straight back, which minted no new versions at all because every
field hashed identically. `instructions` may be a plain string or an **array of lines**; the array is what
`eject` writes for multi-line prose, because a paragraph on one JSON line is unreadable in a pull request.

Once a push has run, those Skills and that Binder are **read-only in Bindry** — the app refuses an edit and
names the repository, commit and file instead of accepting a change the next push would silently discard.

In GitHub Actions, a workspace API key is the only credential needed. `GITHUB_REPOSITORY` and `GITHUB_SHA`
are picked up automatically, so nothing needs passing:

```yaml
name: Publish rules to Bindry
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx bindry publish
        env:
          BINDRY_API_TOKEN: ${{ secrets.BINDRY_API_TOKEN }}
```

That stages the Binder rather than publishing it, which is the right default for a job that runs on every
commit — a human decides when to cut a version. Add `--publish --binder-version ${{ github.ref_name }}` (or
whatever your versioning is) to a release workflow when you want CI to publish too.

The command exits non-zero if any document fails, and a failed document blocks the publish even when
publishing was asked for: a rules set with a rule missing is worse than one that did not update.

`--api-base <url>` overrides the API (default `https://api.bindry.ai`, or `$BINDRY_API_BASE`) for pointing at
a local or staging API instead.

## What's actually been verified

- `search`, and `show` on a public slug (including a not-found identifier), were run against the real,
  live production API (`https://api.bindry.ai`) — real 200s, real 404 handling, response shapes matched what's
  documented here.
- `login`, `whoami`, `list`, `show` (by GUID), `pull` (`--target skill-bundle` default, `--mode live`, and
  `--target markdown`), and `check`'s drift comparison were all verified end-to-end against a real workspace on
  `test-api.bindry.ai` with a real Personal API Key: a real Draft Binder with two real Skills, correct
  private-route resolution by GUID, correct compiled SKILL.md content and pin comments, and `check` correctly
  reporting both Skills as up to date immediately after a pull.
- `show`/`pull` on a **slug** correctly fail for a private, unpublished (Draft) Binder — a slug alone can't be
  routed to a specific private workspace, only a GUID can (with a token) or a public listing can (with a slug).
  This is the documented, intended behavior, confirmed against the real API, not a gap.
- Also verified end-to-end against a fixture HTTP server shaped exactly like the real controllers
  (`Bindry.API/Controllers/{Binders,PublicCatalog}Controller.cs`), covering a drift scenario (a pin baked in at
  one version, the server reporting the Skill has since moved to another) reported correctly as stale.
- `pull`/`check` on a **standalone Skill** (no Binder at all) were verified against that same fixture server
  only — the public catalog had no published standalone Skill to pull for real at the time this was built.
  The `bindry:pin` comment correctly omits `binder=` entirely for these (rather than fabricating one), and
  `check` correctly resolves such a pin by the Skill's own id instead of trying a Binder lookup.

## Also verified for publishing (BIND-0197)

Against a real API with only an `X-Api-Key`, no browser session: ejecting an app-authored Binder of two
Skills and pushing the folder straight back took authorship over and minted **zero** new versions; editing
one rule's prose bumped that one to 1.0.1 and left the other alone; deleting a file reported the removal and
dropped it from the Binder while the Skill itself stayed alive and unarchived; `--publish --binder-version
2.0.0` published it, and an anonymous consumer's export returned the edited content.

## Current limitations

- No shell completion, no interactive prompts — every argument is explicit, on purpose, so it stays scriptable.
- `check`'s drift comparison, like the plugins' own `/bindry-check`, can only report "pinned at X, Binder now
  pins Y," not how many versions behind that is — the API doesn't expose a Skill's full version history.
- `check` also reads Copilot's path-matched `.github/instructions/*.instructions.md` files (rows marked
  `kind: "instructions"` in `--json`), but can only measure one against a Binder it found another way: those files
  record their skill, not the Binder they came from, so a Binder made *only* of path-shaped skills has nothing to
  match against and its files are reported as `unchecked`. The plugins' `/bindry-check` does not have this limit,
  because it knows its one Binder from `bindry.config.json`.

## Importing what you already have

If a project already has instruction files, `bindry import` turns them into Skills rather than
making you retype them:

```bash
bindry import                 # this directory
bindry import ../other-repo   # somewhere else
bindry import --dry-run       # show what would be created, write nothing, no login needed
```

It reads **local files only** — no GitHub App, no OAuth, nothing stored. Recognised today:
`.claude/skills/*/SKILL.md`, `.agents/skills`, `.github/skills`, `.cursor/rules/*.mdc`,
`.windsurf/rules/*.md`, and `.github/instructions/*.instructions.md`. Each one becomes a **draft**,
private where your plan allows it, and nothing is published — that stays a deliberate act in the app.

Two things it deliberately does not do:

- **Prose is reported, not imported.** `AGENTS.md` and `.github/copilot-instructions.md` are many
  rules in one file; splitting them is the AI-assisted import in the app, which costs credits.
- **Scripts and assets beside a skill are ignored.** We import instructions, not executables.

An imported Skill is thin on purpose: no source format carries Bindry's "when it does *not*
apply" or "how to verify it held", and a glob like `src/**/*.ts` says *where*, not *when* — it is
recorded literally so you can rewrite it into a real trigger rather than finding a guess in its place.
