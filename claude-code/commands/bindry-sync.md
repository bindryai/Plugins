---
description: Compile a bound Bindry Binder into Claude Code skills for this project
argument-hint: "[binder-id | path-to-binder-export.json] [--mode pinned|live] [--version <v>|latest]"
---

Compile a Bindry Binder into Claude Code skills so its Skills load on demand instead of sitting in every prompt.

1. Determine the source, in order:
   - `$1` if it looks like a Binder id (GUID) or a full export URL — sync live from the Bindry API.
   - `$1` if it's a file path — compile from that local export file.
   - If `$1` is empty, check for `./bindry.config.json` in the current project (written by a previous sync) and reuse the Binder id it remembers.
   - If none of those apply, tell the user to either pass a Binder id (from Bindry → Binder → Export → target "claude") or a saved export file path, then stop.
2. For a live sync, also need `--api-base <url>` (the Bindry API's base URL — ask the user if not obvious from context) and, for a private Binder, `--token <api-key>` (generated from the workspace's team page in Bindry, not Account settings). A published Library Binder (referenced by slug or GUID) needs no token at all — it resolves through the public Library's anonymous export route. Only your own private Binders require one.
3. Default is `--mode pinned` (a static snapshot). If the user wants this Binder to always stay current instead — `--mode live` — first check `claude mcp get bindry`. If it doesn't report connected, tell the user to run `/bindry-connect` first and stop; compiling live skills with no live connection would produce skills that always fail when an agent tries to use them. `--mode live` also only works from a live Binder id/URL, not a local export file — its Skills need real GUID ids, which a hand-written or example export file won't have.
4. If the user wants a specific published version of a Library Binder rather than its latest — e.g. rules for the framework release they are actually on — pass `--version <v>`. The version is remembered in `bindry.config.json`, so later syncs stay on it until `--version latest` removes the pin. Two things to know before offering it: a version pin only applies to a Library Binder (your own workspace Binder always compiles from its current composition), and an unknown version fails with a message naming the versions that do exist rather than quietly serving the latest.
5. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/compile-binder.mjs" [<binder-id-or-file>] --out .claude/skills [--api-base <url>] [--token <api-key>] [--mode pinned|live] [--version <v>]`
6. Report exactly what the script printed: how many skills were written and where. If it failed with an authentication error, tell the user plainly what it said — don't guess or retry silently. If it wrote a `bindry.config.json`, mention that future `/bindry-sync` runs in this project can omit the Binder id (and remember the mode too).
7. Remind the user to re-run `/bindry-sync` whenever a **pinned** Binder changes in Bindry — each pinned skill is tagged with a Skill version in an HTML comment, so a future `/bindry-check` can diff against it. A **live** skill never goes stale — it calls the Bindry MCP server for current content every time an agent uses it — so there's nothing to re-sync for it, only re-run if the Binder's Skill *list* itself changed (added/removed Skills).
8. If any Skill carries a file attachment (e.g. an exact logo to place), the script downloads it into that skill's `assets/` folder alongside `SKILL.md` — in both pinned and live mode, since the live MCP tools don't serve binary files. If the script printed a warning that it skipped an asset, mention that plainly too — that skill still compiled, just without the file, and needs a `--api-base`/network fix before it will download.
