---
description: One-time setup connecting Claude Code to the Bindry MCP server, for live-mode skills
argument-hint: "--api-base <url>"
---

Connect this machine to the Bindry MCP server so `--mode live` skills (compiled by `/bindry-sync`) actually
work. This is a one-time, per-machine/user step — it isn't tied to any particular project or Stack, and only
needs to happen once even if you sync several Stacks live later.

1. Explain up front: this needs an API key with the **`mcp` tool scope** granted specifically — not the same
   as a token used for pinned `/bindry-sync`. Generate or edit one from Bindry → Account settings → API keys,
   granting MCP tool access. Recommend the user put it in a `BINDRY_API_TOKEN` environment variable rather than
   pasting it directly — same variable name pinned mode already uses.
2. Need `--api-base <url>` (the Bindry API's base URL — ask if not obvious from context, e.g. from an existing
   `bindry.config.json` in a project this user has already synced).
3. This changes standing local CLI configuration (adds an MCP server to this machine's Claude Code config) —
   state the exact command below and get explicit confirmation before running it, don't run it silently:
   ```
   claude mcp add --transport http bindry <api-base>/api/mcp --header "X-Api-Key: ${BINDRY_API_TOKEN}" --scope user
   ```
4. After running it, confirm with `claude mcp get bindry` — it should report `Status: ✔ Connected`. If it
   reports a connection failure, report exactly what it said (bad API base, network issue, or a key that's
   missing the `mcp` tool scope show up as different failures — don't guess which without checking).
5. Once connected, tell the user live-mode skills are ready to use — `/bindry-sync <stack-id> --mode live` will
   now compile skills an agent can actually call MCP tools through, and `/bindry-check` will report them as
   "live (always current)" rather than stale or unknown.
