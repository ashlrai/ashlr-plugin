---
name: ashlr-settings
description: View or change ashlr-plugin settings.
---

Settings for the ashlr-plugin live in `~/.claude/settings.json` under the `ashlr` key:

```json
{
  "ashlr": {
    "attribution": true,
    "statusLine": true,
    "statusLineSession": true,
    "statusLineLifetime": true,
    "preferAshlrTools": true,
    "savingsLogPath": "~/.ashlr/stats.json"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `attribution` | `true` | Add "Assisted-By: ashlr-plugin" to commits made via ashlr:code |
| `statusLine` | `true` | Master toggle for the ashlr status line |
| `statusLineSession` | `true` | Show session token savings in the status line |
| `statusLineLifetime` | `true` | Show lifetime token savings in the status line |
| `preferAshlrTools` | `true` | Hint to `ashlr:code` to prefer `ashlr__*` tools over built-ins |
| `savingsLogPath` | `~/.ashlr/stats.json` | Where to persist savings stats |

Parse the user's request, read the current settings, apply the change using the Edit tool, and confirm the new value.

If the user asked a question rather than requested a change, just show the relevant current value.
