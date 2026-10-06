# Bindry plugin for Claude Code

Compiles a bound Bindry Binder into Claude Code skills — one skill per Skill — so instructions load only when
a task actually matches them, instead of sitting in the context window on every single turn.

## What it does

Claude Code loads a skill on demand, based on its `description`, rather than keeping it loaded permanently.
This plugin turns each Skill in a Binder (its instructions, constraints, and verification steps) into a skill
under `.claude/skills/<skill-slug>/SKILL.md`, so the "Multi-Tenant Table Partitioning" Skill only enters
context when Claude Code is actually touching storage code — not on every request.

Each generated skill carries a pin comment recording which Skill version it was compiled from
(`<!-- bindry:pin binder=... skill=... version=... -->`), so a future sync can tell you when a Binder has moved
on and the local skills are stale.

Skills that carry a file attachment (a logo that must be placed exactly, not redrawn) get the file itself
downloaded alongside the skill, at `.claude/skills/<skill-slug>/assets/<filename>`, with the skill body
referencing that local copy — so Claude Code can point at (or embed) the exact bytes instead of guessing.

## Install

```bash
claude plugin marketplace add bindryai/Plugins
claude plugin install bindry@bindry-plugins
```

The marketplace manifest lives at the repo root (`Bindry.Plugins/.claude-plugin/marketplace.json`), listing
this plugin at `source: "./claude-code"` — that's why `marketplace add` points at the whole repo, not this
subdirectory. Verified working end-to-end on Claude Code v2.1.238 against the real pushed repo: both commands
above complete successfully and `claude plugin list` shows `bindry@bindry-plugins` as installed and enabled.

To try a local checkout instead of the published repo, point `marketplace add` at the repo root on disk
(`/path/to/Bindry.Plugins`, not this `claude-code` subdirectory) — same two commands otherwise.

or, for the fastest way to try just the command without the plugin system, copy `commands/bindry-sync.md` and
`scripts/compile-binder.mjs` straight into a project's `.claude/commands/` and `.claude/scripts/` (adjust the
`${CLAUDE_PLUGIN_ROOT}` path in the command to match).

## Use

**Live sync (the real path):**

1. Generate an API key from the workspace's team page in Bindry (not Account settings — a key is scoped to
   whichever workspace's team page you made it from). Name it, optionally set an expiry, and you're done —
   there's no permission picker; a key already does everything you can do in that workspace. Only needed for
   your own private Binders — a published Binder from the Library needs no key at all, see "Installing
   someone else's Binder" below.
2. Run `/bindry-sync <binder-id> --api-base http://localhost:5160 --token <api-key>` once. It writes
   `bindry.config.json` in the project root remembering the Binder id and API base.
3. Re-run `/bindry-sync` any time the Binder changes — no arguments needed the second time, it reuses
   `bindry.config.json`. A failed auth check reports a clear error (never a silently empty result).

**Pinning to a published version:**

A Library Binder's rules often describe a specific release of whatever they are rules for. `/bindry-sync
<binder-slug> --api-base <url> --version 2.8.0` compiles that published version instead of the latest, and
records it in `bindry.config.json` — so a bare re-sync stays on 2.8.0 even after the publisher ships 3.0.0.
`--version latest` removes the pin. An unknown version fails with a message naming the versions that do
exist; it never quietly falls back to the latest, which is the whole point.

Pinning applies to Library Binders. Your own workspace Binder always compiles from its current composition —
being able to edit it and see the change is why you own it.

**From a local export file** (offline testing, or the bundled example):

1. Save a Binder export JSON as `bindry.binder.json` in your project root — an example is included at
   `examples/git-flow-command-center.binder.json` if you want to try it without a real export.
2. Run `/bindry-sync path/to/export.json`.

**Checking for drift:**

Run `/bindry-check` any time — it reads the pin comment back out of every compiled `SKILL.md` and compares it
against the Binder's *current* pinned version for that Skill (a plain `GET /api/binders/{id}`, not a full
export), reporting each skill as up to date, stale (naming both version strings), live (see below), or unknown
(no pin comment, or the Skill was removed from the Binder). It's read-only — it never edits anything or
re-syncs for you; run `/bindry-sync` yourself once it tells you what's stale. It reuses the Binder id/API base
from `bindry.config.json` just like `/bindry-sync` does, so it needs at least one prior sync to know what to check.

On a version-pinned project it reports two things separately, because conflating them makes a pinned project
look permanently broken: whether the compiled skills match the version you pinned, and whether the Binder has
published a newer one since. The second is information, not staleness.

It also reports Copilot's path-matched instruction files. A skill with `appliesToPaths` compiles to
`.github/instructions/<slug>.instructions.md` at the repo root instead of a `SKILL.md`, so the scan above never sees
one; `/bindry-check` reads the `bindry:instructions` marker those files carry and reports each in its own section, as
up to date, stale, or "not in this Binder" (named, not judged: it may belong to a second Binder). A repo with none
prints nothing extra. A file that was deleted is not reported, and a skill that stops being path-matched leaves its
old file behind for you to delete: a sync writes files, it does not remove them.

## Live mode

By default `/bindry-sync` compiles a **pinned** snapshot — a skill's instructions are copied in at compile
time and go stale until you re-sync. Add `--mode live` to compile a **live** skill instead: its body carries no
instructions at all, just a pointer telling the agent to call the Bindry MCP server's `bindry.skills.get`
tool for this Skill's current content every time it's used. A live skill never goes stale — there's nothing
`/bindry-check` needs to flag, so it reports these as "live (always current)."

Live mode needs a one-time connection to the Bindry MCP server — run `/bindry-connect` once per machine. The
same key `/bindry-sync` already uses works here too; there's no separate permission to grant for MCP access.

```bash
node scripts/compile-binder.mjs <binder-id> --api-base http://localhost:5160 --token <api-key> --mode live --out .claude/skills
```

Verified live: compiled a real Binder in `--mode live` and confirmed the output skill's frontmatter `description`
matched what pinned mode would have produced (skills still trigger the same way — only the body differs), with
no instructions/constraints/verification text embedded and a `bindry:live` comment carrying the real Skill
GUID. Called `bindry.skills.get` for that Skill through a real MCP client, then edited the Skill's
instructions in the running API and called it again — confirmed the tool returned the new text immediately,
while the compiled file on disk had nothing to go stale in the first place. Also confirmed `/bindry-check`
correctly reports a live skill as "live (always current)" alongside a stale pinned one in the same directory,
and correctly flips a live skill to "unknown" once its Skill is removed from the Binder.

## Try it right now, without Claude Code

The compiler is a plain, dependency-free Node script, so you can run it directly:

```bash
# from a local export file
node scripts/compile-binder.mjs examples/git-flow-command-center.binder.json --out .claude/skills

# a Skill with an attachment (logo file) — downloads the asset alongside the skill
node scripts/compile-binder.mjs examples/brand-guidelines.binder.json --out .claude/skills

# live, from a running Bindry API
node scripts/compile-binder.mjs <binder-id> --api-base http://localhost:5160 --token <api-key> --out .claude/skills
```

Verified against a real running Bindry API: created a Binder + Skill, generated an API key, ran the live sync,
confirmed the compiled SKILL.md matched the API's data exactly, confirmed a second run with no arguments reused
`bindry.config.json`, and confirmed an unauthenticated request against a private Binder fails with a clear error
instead of silently writing nothing.

Attachment download was verified the same way: uploaded a real logo file to a live Skill, exported it (the
API returns each attachment's own relative content URL), and confirmed the compiler resolved that URL against
`--api-base`, sent the same API key to fetch it, and wrote bytes identical to the original upload into
`assets/`. A relative attachment URL with no `--api-base`, an unreachable host, and a non-2xx response are all
handled the same way: the asset is skipped with a clear warning and the rest of the sync (including that
Skill's own skill) still completes — one bad asset never fails the whole run.

```bash
node scripts/check-drift.mjs --api-base http://localhost:5160 --token <api-key>
```

Verified live: synced a real Binder, confirmed a fresh sync reports up to date; published a new Skill version
and re-pinned the Binder to it, confirmed the drift check then reported the local skill as stale (naming both
version strings) without touching the file on disk; confirmed a hand-authored `SKILL.md` with no pin comment is
reported as unknown rather than crashing or being silently skipped.

## Installing someone else's Binder

`/bindry-sync` is not limited to Binders you own. Pass a Library **slug** (or the Binder's GUID) with no
token at all and it resolves through the public Library:

```bash
/bindry-sync git-flow-command-center --api-base https://api.bindry.ai
```

That works because `GET /api/public/catalog/binders/{slug-or-guid}/export/file` is anonymous. The listing in
the public Library *is* the permission check: a Binder appears there only while it is Published with Public
visibility and not archived, and drops out the moment any of that stops being true.

When a token *is* present and the identifier is a GUID, the workspace route is tried first and the public
route is the fallback — so a key scoped to your own workspace never blocks you from installing a public
Binder. Private Binders still need `--token`, exactly as before.

## Current limitations

- `/bindry-check` reports "compiled at X, Binder now pins Y," not "N versions behind" — the API doesn't expose a
  Skill's full version history today, only its current pinned version, so there's nothing to count against.
- `--mode live` requires real GUID Skill ids from a live-fetched Binder. The bundled `examples/*.binder.json`
  files use illustrative ids (e.g. `bnd_git_branch_pr_hygiene`) for readability, not real GUIDs, so they can't
  be compiled live — those Skills are skipped with a warning rather than producing a skill that would always
  fail when an agent tries to use it.
- Attachments are still downloaded and pinned to disk at compile time even in live mode — `bindry.skills.get`
  returns a Skill's text content only, not its file attachments, so there's no live path for binary assets yet.
