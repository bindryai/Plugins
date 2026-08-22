---
description: Compile a bound Bindry Stack into Claude Code skills for this project
argument-hint: "[stack-id | path-to-stack-export.json]"
---

Compile a Bindry Stack into Claude Code skills so its Bindings load on demand instead of sitting in every prompt.

1. Determine the source, in order:
   - `$1` if it looks like a Stack id (GUID) or a full export URL — sync live from the Bindry API.
   - `$1` if it's a file path — compile from that local export file.
   - If `$1` is empty, check for `./bindry.config.json` in the current project (written by a previous sync) and reuse the Stack id it remembers.
   - If none of those apply, tell the user to either pass a Stack id (from Bindry → Stack → Export → target "claude") or a saved export file path, then stop.
2. For a live sync, also need `--api-base <url>` (the Bindry API's base URL — ask the user if not obvious from context) and, for a private Stack, `--token <api-key>` (generated from Bindry → Account settings → API keys). Public Stacks don't need a token yet — but note that today `/api/stacks/{id}/export` is a workspace-scoped endpoint, so in practice this means "your own Stacks," not someone else's published one.
3. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/compile-stack.mjs" [<stack-id-or-file>] --out .claude/skills [--api-base <url>] [--token <api-key>]`
4. Report exactly what the script printed: how many skills were written and where. If it failed with an authentication error, tell the user plainly what it said — don't guess or retry silently. If it wrote a `bindry.config.json`, mention that future `/bindry-sync` runs in this project can omit the Stack id.
5. Remind the user to re-run `/bindry-sync` whenever the Stack changes in Bindry — each generated skill is pinned to a Binding version in an HTML comment, so a future `/bindry-check` can diff against it.
6. If any Binding carries a file attachment (e.g. an exact logo to place), the script downloads it into that skill's `assets/` folder alongside `SKILL.md`. If the script printed a warning that it skipped an asset, mention that plainly too — that skill still compiled, just without the file, and needs a `--api-base`/network fix before it will download.
