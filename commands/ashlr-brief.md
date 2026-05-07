---
name: ashlr-brief
description: Toggle response-shortening (caveman-inspired, ashlr-flavored) with three intensity levels. Trims filler from Claude's prose to save 30–55% on output tokens while keeping code blocks, errors, and destructive-action confirmations in full grammar.
argument-hint: "on [lite|standard|concise] | off | status | --project [level]"
---

Toggle ashlr-brief — a tunable, opt-in response-shortening layer. Free users get user-level preferences; Pro/Team users get project-level enforcement.

## Usage

```
/ashlr-brief on                    # enable at default level (standard)
/ashlr-brief on lite               # mild trim — keeps full grammar
/ashlr-brief on standard           # default — drop padding
/ashlr-brief on concise            # max — fragments + arrows allowed
/ashlr-brief off                   # disable
/ashlr-brief status                # show current level + active source
/ashlr-brief --project standard    # write `.ashlr/brief.json` (Pro/Team only)
```

## What it does

| Level | Reduction | Effect |
|-------|-----------|--------|
| `lite` | ~25–35% | Drops filler; keeps full grammar |
| `standard` (default) | ~35–45% | Drops padding + transitions; keeps grammar |
| `concise` | ~50–60% | Fragments + arrows OK; abbreviations allowed for prose only |

Code blocks, error messages, file paths, and destructive-action confirmations are always rendered in full grammar regardless of level. See `skills/ashlr-brief/SKILL.md` for the full ruleset.

## Steps

### `on [level]`

1. Default level if omitted: `standard`. Validate level is one of `lite | standard | concise`.
2. Write to `~/.ashlr/brief.json`:
   ```json
   { "level": "standard", "setAt": "<ISO8601>", "source": "user" }
   ```
   Use `mkdir -p ~/.ashlr` first if needed.
3. Print:
   ```
   ashlr-brief: <level> ON. Effective on the next response.
   - Code blocks, errors, and destructive confirmations remain in full grammar.
   - Status line shows `[brief: <level>]` while active.
   Toggle off with: /ashlr-brief off
   ```

### `off`

1. Write to `~/.ashlr/brief.json`:
   ```json
   { "level": "off", "setAt": "<ISO8601>", "source": "user" }
   ```
2. Print: `ashlr-brief: OFF. Default verbosity restored.`

### `status`

1. Read `~/.ashlr/brief.json` (level field).
2. Read `<repo-root>/.ashlr/brief.json` if present (project override).
3. Print:
   ```
   ashlr-brief status
     user-level:    <level> (~/.ashlr/brief.json)
     project-level: <level> (.ashlr/brief.json) — Pro-enforced
     effective:     <project wins if Pro-set, else user>
   ```
   If no file exists for either, show `<not set>`.

### `--project [level]`

1. Check Pro/Team tier via `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/check-tier.ts` (or read `~/.ashlr/pro-token-cache.json`). If free, print:
   ```
   ashlr-brief: --project requires Pro or Team tier.
   Run /ashlr-upgrade to enable project-level enforcement.
   ```
   and stop.
2. Otherwise write `.ashlr/brief.json` in the current repo root with:
   ```json
   { "level": "<level>", "setAt": "<ISO8601>", "source": "project", "writtenBy": "<email>" }
   ```
3. Print:
   ```
   ashlr-brief: project-level <level> written to .ashlr/brief.json.
   Commit this file so teammates pick it up. Project setting overrides user-level.
   ```

### No argument

Show `status` (above).

## Notes

- The skill content is in `skills/ashlr-brief/SKILL.md` and is auto-injected into session context by `hooks/sessionstart-brief.ts`.
- Natural-language activators ("be brief", "tldr", "less tokens", "stop being brief") are handled by `hooks/userpromptsubmit-brief-trigger.ts` — no slash command required.
- `/ashlr-eco-mode on` auto-activates `standard` if user hasn't already chosen a level.
- Real-data evaluation: `bun run scripts/brief-eval.ts` runs a 3-arm comparison (verbose / brief / "be terse" raw instruction) to verify reduction claims with real token counts.
