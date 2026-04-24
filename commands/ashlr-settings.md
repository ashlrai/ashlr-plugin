---
name: ashlr-settings
description: View or change ashlr-plugin settings.
---

Settings for the ashlr-plugin live in `~/.claude/settings.json` under the `ashlr` key. All toggles default to `true` unless stated otherwise.

```json
{
  "ashlr": {
    "attribution": true,
    "statusLine": true,
    "statusLineSession": true,
    "statusLineLifetime": true,
    "statusLineTips": true,
    "editBatchingNudge": true
  }
}
```

| Key | Default | What it controls |
|-----|---------|------------------|
| `attribution` | `true` | `commit-attribution` hook appends `Assisted-By: ashlr-plugin` to git commits |
| `statusLine` | `true` | Master toggle for the status-line integration |
| `statusLineSession` | `true` | Show this session's savings in the status line |
| `statusLineLifetime` | `true` | Show lifetime savings in the status line |
| `statusLineTips` | `true` | Rotate short tips in the status line |
| `editBatchingNudge` | `true` | Nudge the agent to batch multiple edits to the same file |

> `toolRedirect` was retired in v1.18: the Read/Grep/Edit routing is handled by the `pretooluse-*` hooks and controlled via `ASHLR_HOOK_MODE` (`redirect` | `nudge` | `off`) or `~/.ashlr/settings.json { "toolRedirect": false }` for a full opt-out. The old `~/.claude/settings.json { ashlr: { toolRedirect } }` key is ignored.

## Applying a change

Parse the user's request, read the current settings file with `Read` or `ashlr__read`, apply the change via `Edit` or `ashlr__edit`, and confirm the new value.

Changes to hook-driven toggles (`attribution`, `editBatchingNudge`) take effect on the next tool call. Changes to status-line toggles take effect on the next status-line refresh.

## Status-line install

If the user hasn't installed the status line yet, the settings file won't have a `statusLine.command` entry. Run:

```bash
bun run ~/.claude/plugins/ashlr-plugin/scripts/install-status-line.ts
```

That writes a safe, idempotent entry into `~/.claude/settings.json` pointing at `scripts/savings-status-line.ts`. A timestamped backup is made before any write.

## If the user just asked a question

Show the relevant current values without editing anything.
