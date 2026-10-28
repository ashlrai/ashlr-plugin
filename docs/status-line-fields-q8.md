# Status line fields

The Claude Code status line is produced by `scripts/savings-status-line.ts`. It summarizes local savings and optional context and activity information. A wide line can look like:

```text
ashlr · 7d ⠀⠄⠆⠇⠧⠷⣿ · ctx: 50% · session ↑+12.3K ≈$0.01 · lifetime +1.2M (est.) · * 3d streak · ☁ 2 machines · brief: concise · last: ashlr__read +5.0K [2s ago] · tip: use /ashlr-savings to see totals
```

The example combines optional fields; actual content depends on data, settings, terminal capabilities and available width. `+` indicates tokens saved, not tokens spent. Counts below 1,000 are whole tokens; `K` means thousands and `M` millions, rounded to one decimal.

| Field | Meaning and units | When absent or unknown |
| --- | --- | --- |
| `ashlr` | Identifies the status line. | The master `statusLine` setting can disable the entire line; an error can also produce an empty line. |
| Heartbeat and sparkline | The heartbeat animates around recent saving activity. The seven sparkline cells show daily tokens saved over the last seven days, scaled relative to the largest day; `7d` appears when the width budget exceeds 100 columns. | Missing daily values are treated as zero. Both are hidden by `statusLineSparkline: false`; animation and glyphs depend on terminal capabilities. |
| `ctx: 50%` | Context used as a percentage of the supplied context limit, rounded to a whole percent and capped at 100%. Color changes at 60%, 80%, and 95% when supported. | Hidden unless stdin supplies numeric `context_used_tokens` and a positive `context_limit_tokens`; a token count alone is insufficient. It can also be dropped for width. |
| `session ↑+12.3K` | Tokens saved for the current session, summed over matching session buckets. `↑` (or ASCII `+`) indicates a save within the last four seconds. | No matching bucket defaults to zero; legacy stats may use a shared session counter. With no stats file, the line says `(waiting for first tool call)`; with fewer than five lifetime calls and zero session savings it says `session +0 (collecting…)`. Corrupt stats fall back to zero. `statusLineSession: false` hides the segment. |
| `≈$0.01` | Approximate US dollars saved for the session, calculated from saved tokens and the active summarizer's input price; values under one cent display as `≈$0.00`. This is an estimate, not a bill. | A zero or unusable token count displays `≈$0.00`; the cost can be dropped for width. |
| `lifetime +1.2M (est.)` | All-time tokens saved in local stats. `(est.)` uses estimated savings; `(API-measured)` selects the measured total once at least ten calls have measurements. | Normally hidden if the file is missing or the selected total is zero, or when `statusLineLifetime` is false. Width reduction can rebuild the segment without its method label and can show zero. |
| `* 3d streak` | Current streak of active days from local streak data. | Hidden below three days or when streak data is missing or unreadable; it can be dropped for width. |
| `☁ 2 machines` | Number of machines in the cached cross-machine aggregate for a Pro user. | Hidden without a usable Pro token or aggregate, or when the count is at most one. The displayed cache may be stale: the pull uses a one-hour freshness window, but the status-line reader does not reject an expired cache. |
| `brief: concise` | Active user-level brief configuration, read from `~/.ashlr/brief.json`. | Hidden if the file is missing or unreadable, the level is missing, or it is `off`. |
| `last: ashlr__read +5.0K [2s ago]` | Recent save age in seconds and a tool's session token savings. The tool is the candidate with the largest accumulated savings, a proxy for the most recent tool; the number is its accumulated savings, not necessarily the last call's saving. | Shown only within 60 seconds of the session's last saving timestamp and when a tool has positive savings. Missing timestamps or per-tool data hide it; it can be dropped for width. |
| `tip: …` or `↑: …` | A rotating usage tip, or an upgrade hint for an apparently free user with at least 50,000 session tokens saved. | Hidden by `statusLineTips: false` or if it does not fit. `statusLineUpgradeNudge: false` disables the upgrade hint. |

Settings are under `ashlr` in `~/.claude/settings.json`; the master, session, lifetime, tips and sparkline switches default to enabled. The line uses `COLUMNS` (default 80, maximum 120) as its visible-width budget. Under pressure it removes optional detail, then the cost and context, and finally truncates with an ellipsis. Therefore an omitted field is not evidence of a zero value.

Local stats and settings are read from disk with a process-local 300 ms cache that invalidates on file modification. Updates can lag the write; the display has no general stale-data indicator. The last-save age is based on the stored timestamp, and disappears after its window rather than marking old data stale. The cloud machine count can remain visible from an expired cache. A blank line, zero fallback, or absent field should not be interpreted as proof that the underlying data is current.
