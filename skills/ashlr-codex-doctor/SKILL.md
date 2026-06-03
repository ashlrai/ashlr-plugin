---
name: ashlr-codex-doctor
description: Check Ashlr's Codex plugin packaging, MCP manifest, hooks, skills, and workspace allow-list. Use when Codex setup, plugin loading, or MCP registration looks wrong.
---

# Ashlr Codex Doctor

Run:

```sh
ashlr codex-doctor --json
```

Read the JSON before changing files. Focus on:

- `pluginManifest.present`, `hasSkills`, `hasMcpServers`, and `hasHooks`
- `mcp.server` and `mcp.bin`
- `hooks.defaultMode`, which should normally be `nudge`
- `workspaceAccess.allowProjectPaths` when tools refuse paths outside cwd

If workspace access is the issue, set `ASHLR_ALLOW_PROJECT_PATHS` to the absolute project root before launching Codex or pass explicit `cwd` arguments to Ashlr MCP tools.
