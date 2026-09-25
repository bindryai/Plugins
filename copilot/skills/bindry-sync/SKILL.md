---
name: bindry-sync
description: Compile a bound Bindry Stack into GitHub Copilot skills for this project, so its Bindings load on demand instead of sitting in every prompt. Use when the user asks to sync, install, or update Bindry Stack skills for this project.
---

Compile a Bindry Stack into GitHub Copilot skills so its Bindings load on demand instead of sitting in every
prompt. Invoke explicitly with `/bindry-sync`, or let it trigger automatically when the user asks to
sync/update Bindry skills.

1. Determine the source from what the user actually said, in order:
   - A Stack id (GUID), a Library slug, or a full export URL they gave you — sync live from the Bindry API.
   - A file path they gave you — compile from that local export file.
   - Neither given: check for `./bindry.config.json` in the current project (written by a previous sync) and
     reuse the Stack id it remembers.
   - None of those apply — ask the user for a Stack id (from Bindry → Stack → Export → target "copilot") or a
     saved export file path, then stop.
2. For a live sync, also need `--api-base <url>` (the Bindry API's base URL — ask the user if not obvious from
   context) and, for a private Stack, `--token <api-key>` (generated from the workspace's team page in Bindry,
   not Account settings) or the `BINDRY_API_TOKEN` environment variable. A published Library Stack
   (referenced by slug or GUID) needs no token at all — it resolves through the public Library's anonymous
   export route. Only your own private Stacks require one.
3. Default is `--mode pinned` (a static snapshot). If the user wants this Stack to always stay current instead
   — `--mode live` — first confirm the Bindry MCP server is configured by running `copilot mcp get bindry`. If
   it isn't there, tell the user to use the `/bindry-connect` skill first and stop; compiling live skills with
   no live connection would produce skills that always fail when used. `--mode live` also only works from a
   live Stack id/URL, not a local export file — its Bindings need real GUID ids, which a hand-written or
   example export file won't have.
4. If the user wants a specific published version of a Library Stack rather than its latest — e.g. rules for
   the framework release they are actually on — pass `--version <v>`. It is remembered in
   `bindry.config.json`, so later syncs stay on that version until `--version latest` removes the pin. A
   version pin only applies to a Library Stack (your own workspace Stack always compiles from its current
   composition), and an unknown version fails with a message naming the versions that do exist rather than
   quietly serving the latest.
5. The compiler ships with this plugin, two directories up from this skill's base directory:
   `<this skill's base directory>/../../scripts/compile-stack.mjs`. Run:
   `node <that path> [<stack-id-or-file>] --out .github/skills [--api-base <url>] [--token <api-key>] [--mode pinned|live] [--version <v>]`
   If that file doesn't exist, stop and say so plainly rather than guessing a path.
6. Report exactly what the script printed: how many skills were written and where. If it failed with an
   authentication error, tell the user plainly what it said — don't guess or retry silently. If it wrote a
   `bindry.config.json`, mention that future syncs in this project can omit the Stack id (and remember the mode
   too). New skills are picked up on the next session, or immediately after `/skills reload`.
7. Remind the user to re-run this whenever a **pinned** Stack changes in Bindry — each pinned skill is tagged
   with a Binding version in an HTML comment, so the `/bindry-check` skill can diff against it. A **live** skill
   never goes stale — it calls the Bindry MCP server for current content every time it's used — so there's
   nothing to re-sync for it, only re-run if the Stack's Binding *list* itself changed (added/removed Bindings).
8. If any Binding carries a file attachment (e.g. an exact logo to place), the script downloads it into that
   skill's `assets/` folder alongside `SKILL.md` — in both pinned and live mode, since the live MCP tools don't
   serve binary files. If the script printed a warning that it skipped an asset, mention that plainly too —
   that skill still compiled, just without the file, and needs an `--api-base`/network fix before it will
   download.
