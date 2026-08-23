---
name: bindry-sync
description: Compile a bound Bindry Stack into Codex skills for this project, so its Bindings load on demand instead of sitting in every prompt. Use when the user asks to sync, install, or update Bindry Stack skills for this project.
---

Compile a Bindry Stack into Codex skills so its Bindings load on demand instead of sitting in every prompt.
Invoke explicitly with `$bindry-sync`, or let it trigger automatically when the user asks to sync/update Bindry
skills.

1. Determine the source from what the user actually said, in order:
   - A Stack id (GUID) or a full export URL they gave you — sync live from the Bindry API.
   - A file path they gave you — compile from that local export file.
   - Neither given: check for `./bindry.config.json` in the current project (written by a previous sync) and
     reuse the Stack id it remembers.
   - None of those apply — ask the user for a Stack id (from Bindry → Stack → Export → target "codex") or a
     saved export file path, then stop.
2. For a live sync, also need `--api-base <url>` (the Bindry API's base URL — ask the user if not obvious from
   context) and, for a private Stack, `--token <api-key>` (generated from Bindry → Account settings → API
   keys). Public Stacks don't need a token yet — but note that today `/api/stacks/{id}/export` is a
   workspace-scoped endpoint, so in practice this means "your own Stacks," not someone else's published one.
3. Default is `--mode pinned` (a static snapshot). If the user wants this Stack to always stay current instead
   — `--mode live` — first confirm the Bindry MCP server is connected (check the configured MCP servers for one
   named `bindry`). If it isn't connected, tell the user to use the `bindry-connect` skill first and stop;
   compiling live skills with no live connection would produce skills that always fail when used. `--mode live`
   also only works from a live Stack id/URL, not a local export file — its Bindings need real GUID ids, which a
   hand-written or example export file won't have.
4. Locate this plugin's own installed root first (e.g. list installed Codex plugins and find the path for
   `bindry@<marketplace>`), then run:
   `node <resolved-plugin-root>/scripts/compile-stack.mjs [<stack-id-or-file>] --out .agents/skills [--api-base <url>] [--token <api-key>] [--mode pinned|live]`
   If you can't locate `scripts/compile-stack.mjs` under this plugin's installed root, stop and say so plainly
   rather than guessing a path.
5. Report exactly what the script printed: how many skills were written and where. If it failed with an
   authentication error, tell the user plainly what it said — don't guess or retry silently. If it wrote a
   `bindry.config.json`, mention that future syncs in this project can omit the Stack id (and remember the mode
   too).
6. Remind the user to re-run this whenever a **pinned** Stack changes in Bindry — each pinned skill is tagged
   with a Binding version in an HTML comment, so the `bindry-check` skill can diff against it. A **live** skill
   never goes stale — it calls the Bindry MCP server for current content every time it's used — so there's
   nothing to re-sync for it, only re-run if the Stack's Binding *list* itself changed (added/removed Bindings).
7. If any Binding carries a file attachment (e.g. an exact logo to place), the script downloads it into that
   skill's `assets/` folder alongside `SKILL.md` — in both pinned and live mode, since the live MCP tools don't
   serve binary files. If the script printed a warning that it skipped an asset, mention that plainly too —
   that skill still compiled, just without the file, and needs an `--api-base`/network fix before it will
   download.
