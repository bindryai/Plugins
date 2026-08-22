# Bindry plugin for Claude Code

Compiles a bound Bindry Stack into Claude Code skills — one skill per Binding — so instructions load only when
a task actually matches them, instead of sitting in the context window on every single turn.

## What it does

Claude Code loads a skill on demand, based on its `description`, rather than keeping it loaded permanently.
This plugin turns each Binding in a Stack (its instructions, constraints, and verification steps) into a skill
under `.claude/skills/<binding-slug>/SKILL.md`, so the "Multi-Tenant Table Partitioning" Binding only enters
context when Claude Code is actually touching storage code — not on every request.

Each generated skill carries a pin comment recording which Binding version it was compiled from
(`<!-- bindry:pin stack=... binding=... version=... -->`), so a future sync can tell you when a Stack has moved
on and the local skills are stale.

Bindings that carry a file attachment (a logo that must be placed exactly, not redrawn) get the file itself
downloaded alongside the skill, at `.claude/skills/<binding-slug>/assets/<filename>`, with the skill body
referencing that local copy — so Claude Code can point at (or embed) the exact bytes instead of guessing.

## Install

```bash
claude plugin marketplace add MedPACTech/Bindry.Plugins
claude plugin install bindry@bindry-plugins
```

The marketplace manifest lives at the repo root (`Bindry.Plugins/.claude-plugin/marketplace.json`), listing
this plugin at `source: "./claude-code"` — that's why `marketplace add` points at the whole repo, not this
subdirectory. Verified working end-to-end on Claude Code v2.1.238 against the real pushed repo: both commands
above complete successfully and `claude plugin list` shows `bindry@bindry-plugins` as installed and enabled.

To try a local checkout instead of the published repo, point `marketplace add` at the repo root on disk
(`/path/to/Bindry.Plugins`, not this `claude-code` subdirectory) — same two commands otherwise.

or, for the fastest way to try just the command without the plugin system, copy `commands/bindry-sync.md` and
`scripts/compile-stack.mjs` straight into a project's `.claude/commands/` and `.claude/scripts/` (adjust the
`${CLAUDE_PLUGIN_ROOT}` path in the command to match).

## Use

**Live sync (the real path):**

1. Generate an API key from Bindry → Account settings → API keys (only needed for your own private Stacks —
   see the limitation below for what "public" actually means here today).
2. Run `/bindry-sync <stack-id> --api-base http://localhost:5160 --token <api-key>` once. It writes
   `bindry.config.json` in the project root remembering the Stack id and API base.
3. Re-run `/bindry-sync` any time the Stack changes — no arguments needed the second time, it reuses
   `bindry.config.json`. A failed auth check reports a clear error (never a silently empty result).

**From a local export file** (offline testing, or the bundled example):

1. Save a Stack export JSON as `bindry.stack.json` in your project root — an example is included at
   `examples/git-flow-command-center.stack.json` if you want to try it without a real export.
2. Run `/bindry-sync path/to/export.json`.

**Checking for drift:**

Run `/bindry-check` any time — it reads the pin comment back out of every compiled `SKILL.md` and compares it
against the Stack's *current* pinned version for that Binding (a plain `GET /api/stacks/{id}`, not a full
export), reporting each skill as up to date, stale (naming both version strings), or unknown (no pin comment,
or the Binding was removed from the Stack). It's read-only — it never edits anything or re-syncs for you; run
`/bindry-sync` yourself once it tells you what's stale. It reuses the Stack id/API base from `bindry.config.json`
just like `/bindry-sync` does, so it needs at least one prior sync to know what to check.

## Try it right now, without Claude Code

The compiler is a plain, dependency-free Node script, so you can run it directly:

```bash
# from a local export file
node scripts/compile-stack.mjs examples/git-flow-command-center.stack.json --out .claude/skills

# a Binding with an attachment (logo file) — downloads the asset alongside the skill
node scripts/compile-stack.mjs examples/brand-guidelines.stack.json --out .claude/skills

# live, from a running Bindry API
node scripts/compile-stack.mjs <stack-id> --api-base http://localhost:5160 --token <api-key> --out .claude/skills
```

Verified against a real running Bindry API: created a Stack + Binding, generated an API key, ran the live sync,
confirmed the compiled SKILL.md matched the API's data exactly, confirmed a second run with no arguments reused
`bindry.config.json`, and confirmed an unauthenticated request against a private Stack fails with a clear error
instead of silently writing nothing.

Attachment download was verified the same way: uploaded a real logo file to a live Binding, exported it (the
API returns each attachment's own relative content URL), and confirmed the compiler resolved that URL against
`--api-base`, sent the same API key to fetch it, and wrote bytes identical to the original upload into
`assets/`. A relative attachment URL with no `--api-base`, an unreachable host, and a non-2xx response are all
handled the same way: the asset is skipped with a clear warning and the rest of the sync (including that
Binding's own skill) still completes — one bad asset never fails the whole run.

```bash
node scripts/check-drift.mjs --api-base http://localhost:5160 --token <api-key>
```

Verified live: synced a real Stack, confirmed a fresh sync reports up to date; published a new Binding version
and re-pinned the Stack to it, confirmed the drift check then reported the local skill as stale (naming both
version strings) without touching the file on disk; confirmed a hand-authored `SKILL.md` with no pin comment is
reported as unknown rather than crashing or being silently skipped.

## Current limitations

- `/api/stacks/{id}/export` is workspace-scoped — it's "sync your own Stacks," not "install someone else's
  published Stack." Cross-tenant install (binding a Stack you don't own into your project) needs the
  workspace-binding work described on the `BIN-008` card in `Bindry-API` — not built yet.
- `/bindry-check` reports "compiled at X, Stack now pins Y," not "N versions behind" — the API doesn't expose a
  Binding's full version history today, only its current pinned version, so there's nothing to count against.
