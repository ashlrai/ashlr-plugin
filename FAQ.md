# Frequently Asked Questions

Real answers. If your question isn't here, open an issue — I'll add it.

---

### 1. What Claude plan do I need?

Any plan works — Pro, Max, or raw API. The plugin runs inside Claude Code, which runs on whatever plan you've got.

That said, **measurable savings kick in at Max-scale usage** (hours-long sessions, mid-sized repos). On short Pro sessions you'll see smaller absolute numbers — the percentages are the same, the dollar figure is just smaller. If you're using the API pay-as-you-go, `ASHLR_PRICING_MODEL` lets `/ashlr-savings` show the right `$` based on your model.

---

### 2. Does it phone home? Is there any telemetry?

**No.** This is the single most important property of the project.

- `git grep -E 'posthog|analytics|fetch\s*\(.*https?://(?!api\.github)' ` on the repo returns nothing.
- No account. No login. No API key other than Claude's own.
- Stats live at `~/.ashlr/stats.json` on your disk. They never leave your machine.
- **One** deliberate network call: `/ashlr-doctor` hits GitHub's public releases API to check if you're behind. User-invoked, not background.
- `SessionStart` does a local baseline scan — no network.

Compare to WOZCODE, which ships PostHog in `.mcp.json`. Both are valid positions; mine is "zero," theirs is "product analytics." Pick what you trust.

---

### 3. How is "savings" actually measured?

Two independent numbers:

1. **Token savings per call** — compute baseline tokens (what the built-in tool would have returned), compute actual tokens (what the `ashlr__*` tool returned), diff. Tokenizer is `tiktoken cl100k_base` (see Q4 for why).
2. **Dollar savings** — multiply token savings by the per-token price of `ASHLR_PRICING_MODEL` (defaults to sonnet; set to `opus` or `haiku` to match your usage).

The benchmark harness is at `servers/bench.ts`, raw data is at `docs/benchmarks.json`, and you can reproduce the numbers against your own codebase with `/ashlr-benchmark`. Numbers in `/ashlr-savings` reflect the same math on your session's actual calls.

---

### 4. Is the tokenizer exact?

No — Anthropic's tokenizer isn't public. I use `tiktoken cl100k_base` as a proxy.

**Why that's still the honest choice:** the common alternative is `chars / 4`, which overcounts by **~12.9% on code** (measured against tiktoken). That's a big enough gap that `/ashlr-savings` numbers would be consistently inflated by default. Tiktoken is a closer proxy — not perfect, but closer. If Anthropic publishes their tokenizer, I'll swap.

---

### 5. How does ashlr compare to WOZCODE?

Same shape: tri-agent, Read/Grep/Edit redirect, commit attribution, edit-batching, status line, savings tracker.

Ashlr adds: `ashlr__sql`, `ashlr__bash`, `ashlr__tree` MCP tools; a baseline scanner hook; a separate efficiency library (`@ashlr/core-efficiency`) that also powers a standalone CLI; genome scribe loop in v0.5.

Ashlr is: MIT-licensed, open source, no account, zero telemetry, free.
WOZCODE is: closed source, $20/week, polished, has a support channel.

If WOZCODE's polish is worth the subscription, use WOZCODE. If you want to read every line of code that's rewriting your MCP traffic, use this. I genuinely don't think one replaces the other.

---

### 6. Does it work with Cursor / Zed / Windsurf / another editor?

**The MCP servers — yes**, if you wire them up manually. Point your editor's MCP config at `servers/efficiency-server.ts`, `servers/sql-server.ts`, etc. (They're standard MCP, no Claude-Code-specific runtime.)

**The plugin format — no.** The marketplace install, the hooks (tool-redirect, commit-attribution, edit-batching-nudge), the slash commands (`/ashlr-*`), and the status line integration are all Claude-Code-specific. Nobody else implements that plugin schema yet.

---

### 7. Is Opus supported? Does savings math change per model?

Yes and no.

- **Savings math is model-agnostic** — it counts characters/tokens per call, which is the same regardless of model.
- **Pricing math respects `ASHLR_PRICING_MODEL`** — set it to `opus`, `sonnet`, or `haiku` so the `$` figure in `/ashlr-savings` matches what you're actually paying.
- **Opus users see the largest dollar savings**, not because of anything clever in the plugin, but because Opus is the most expensive per-token — the same token savings translates to more dollars.

---

### 8. How accurate are the savings numbers?

Percentages are measured. Dollars are inferred.

- The `−79.5%` mean across files ≥ 2 KB is real, reproducible, and you can verify it with `/ashlr-benchmark` against your own code.
- The `$` figure in `/ashlr-savings` depends on `ASHLR_PRICING_MODEL` being set correctly. If you're on Opus but `ASHLR_PRICING_MODEL=sonnet`, your reported dollars are ~5× too low.
- Tokens are tiktoken-proxied (see Q4) — likely within single-digit % of Anthropic's real count.

Treat the dollar number as "right order of magnitude" not "accurate to the penny."

---

### 9. Does `ashlr__read` actually read my files? Where do the contents go?

`ashlr__read` runs locally in a Bun MCP server on your machine. The file contents:

1. Are read by the local server.
2. Get `snipCompact`ed (head + tail kept, middle elided) in memory.
3. The **snipped view** is returned to Claude Code, which sends it to Anthropic as context — same as the built-in `Read` tool would, just smaller.

No file contents leave your machine except what you'd send to Anthropic anyway. The plugin's job is to **reduce** what gets sent — it never adds a new destination.

---

### 10. Can I trust `ashlr__bash` with secrets in my env?

`ashlr__bash` runs shell commands with `process.env` inherited — same as any shell script you'd run manually. What it does with the output:

- Reads stdout + stderr locally.
- `snipCompact`s stdout over 2 KB. **stderr is never compressed.**
- Returns the result to the agent (which sends it to Anthropic as a tool result — same as any bash tool).
- **Does not log anywhere. Does not persist. Does not ship to a third party.**

Trust model: same as any shell script that's allowed to see your env. If you wouldn't `echo $OPENAI_API_KEY | some-tool` you shouldn't do it here either. `ashlr__bash` refuses catastrophic patterns like `rm -rf /` but does not scrub secrets from output — that's your responsibility.

---

### 11. How do I uninstall?

Two steps:

```
/plugin uninstall ashlr@ashlr-marketplace
rm -rf ~/.ashlr
```

The first removes the plugin from Claude Code. The second removes your local stats and genome cache. If you skip the second, stats will persist and be picked up if you reinstall.

Optional: `rm -rf ~/.claude/plugins/cache/ashlr-marketplace` to remove the clone cache.

---

### 12. What's the "genome"?

A genome is `.ashlrcode/genome/` inside your project — a directory of markdown files, roughly one per concern (auth, storage, api, etc.). Each file is a sectioned spec: short description, relevant paths, conventions, open questions.

When `ashlr__grep` runs in a project with a genome, it retrieves **only the task-relevant sections** via TF-IDF (or Ollama semantic search if available) instead of grepping the whole tree. Saves 40–80% of grep-context tokens on projects that have one.

v0.5 adds the **scribe** — a loop that keeps the genome current as the agent works. You don't have to maintain the spec manually.

Run `/ashlr-genome-init` in your project to try it.

---

### 13. Does the plugin slow down my sessions?

Slightly, in practice. The MCP servers spawn on SessionStart (one-time Bun cold start, ~100–300ms). Per-call overhead is in the single-digit milliseconds for `ashlr__read`/`grep`/`edit`. You'll never feel it.

If you do feel it: `/ashlr-doctor` reports per-server timings. File an issue with the output.

---

### 14. What's the catch?

Honest answer: three things.

1. **Bun is a hard dependency.** If you can't install Bun, you can't install ashlr. Node compat is a reasonable ask but not free to maintain.
2. **Savings compound over session length.** Short sessions (< 30 min, < 10 file reads) may see near-zero absolute savings even though percentages are fine.
3. **v0.5 ships the tokenizer and scribe loop, but some features are still rough.** MySQL isn't wired in `ashlr__sql`. Edit-batching is a nudge, not enforcement. Genome-RAG only helps if you actually run `/ashlr-genome-init`. None of these are blockers, all of them are documented.

No hidden monetization. No telemetry. No "free tier." Not a loss-leader for a paid product. Just a plugin.

---

### 15. I found a bug / have a feature request

- **Bug:** open an issue with `/ashlr-doctor` output + minimal repro. Response within 48h on weekdays.
- **Feature request:** open an issue. I read all of them; I don't promise to implement all of them.
- **Security issue:** see `SECURITY.md` for disclosure process. Don't open a public issue.
- **Efficiency algorithm change:** open the PR against [`@ashlr/core-efficiency`](https://github.com/masonwyatt23/ashlr-core-efficiency), not this repo. The primitives live there.
