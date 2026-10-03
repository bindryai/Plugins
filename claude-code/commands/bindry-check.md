---
description: Report which compiled Bindry skills are stale, without changing anything
argument-hint: "[--dir <skills-dir>]"
---

Check whether the skills already compiled by `/bindry-sync` in this project have fallen behind the Bindry Binder
they came from. This is read-only — it never edits, deletes, or re-syncs a skill, only reports.

1. This needs `bindry.config.json` in the project root (written by a previous `/bindry-sync` run) to know which
   Binder, API base, and pinned version (if any) to check against. If it's missing, tell the user to run
   `/bindry-sync` at least once first, then stop.
2. For a private Binder, also need `--token <api-key>` (generated from the workspace's team page in Bindry, not
   Account settings) or the `BINDRY_API_TOKEN` environment variable — same requirement as `/bindry-sync`.
3. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-drift.mjs" [--dir .claude/skills] [--api-base <url>] [--token <api-key>]`
4. Report exactly what it printed: which skills are up to date, which are stale (and at what version each side
   is), which are **live** (compiled with `--mode live` — always current by design, calls the MCP server
   directly, never goes stale), and which it couldn't check (no pin or live comment, e.g. a hand-authored
   skill, or a Skill no longer in the Binder). If it failed with an authentication error, say so plainly
   rather than retry or guess.
5. If this project is pinned to a Binder version, the report ends with one of two lines, and they mean different
   things. "pinned to X, which is the newest published version" means there is nothing to do. "pinned to X; the
   Binder has since published Y" is **not** staleness — the project is deliberately not following the Binder.
   Relay it as information, and do not tell the user to re-sync unless they say they want to move off the pin.
6. If anything is stale, tell the user to run `/bindry-sync` to update it — this command never does that for
   them. Live skills never need this — don't suggest re-syncing them just because they showed up in the report.

Note on "how far behind": the API doesn't expose full version history for a Skill today, only its current
pinned version, so the report names the two version strings on each side (e.g. "compiled at 1.0.0, Binder now
pins 2.0.0") rather than a version count. Don't invent a count if asked — say this isn't available yet.
