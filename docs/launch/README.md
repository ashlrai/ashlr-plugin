# Launch playbook — ashlr-plugin v0.5.0

A meta-guide for Mason (first-time launcher) covering where each post goes, when to post, what to monitor, and how to answer the questions that will show up in the first 24 hours. If you're reading this and you're not Mason: the tone is internal-note, not polished copy.

---

## When to post what

| Platform | File | Best window (PT) | Why |
|---|---|---|---|
| Hacker News | `hn.md` | **Tue–Thu, 7:30–9:30am PT** | HN front-page algo favors morning US-east activity. Avoid Monday (noisy), Friday (dead), weekends (low-signal). |
| X / Twitter | `x.md` | **Weekday evenings, 6–9pm PT** | Dev-twitter is an after-work crowd. Thread, not single tweet. Pin it. |
| r/ClaudeAI | `reddit.md` (variant 1) | Any weekday, **avoid weekends** | Reddit's Claude subs are active all day; Sat/Sun posts get buried by meme content. |
| r/ClaudeCode | `reddit.md` (variant 2) | Same | Smaller sub, more technical — quality threshold is higher. |

**Order of operations:** Post HN first (highest risk, highest reward). If HN picks up, tweet the HN link. Post Reddit after HN peaks (either way — a dead HN post is still a fine Reddit post, and a live one gives Reddit posts a "here's the discussion" link to include).

**Don't cross-post the HN text verbatim to Reddit.** Reddit mods smell it. Variants in `reddit.md` are pre-tailored.

**Don't submit the same URL to HN twice** in a short window — it'll get flagged. If the first HN submission flops, wait a week and try a different title.

---

## Monitoring checklist (first 24h)

Refresh roughly every 30 min for the first 3 hours, then hourly until bedtime.

- **GitHub stars** — `gh api repos/masonwyatt23/ashlr-plugin | jq .stargazers_count`. Expect 0–50 for a quiet launch, 50–500 for a good HN run.
- **Issues opened** — `gh issue list --repo masonwyatt23/ashlr-plugin`. Respond within 2h if you're awake. A fast first response shapes the whole thread.
- **HN comments** — refresh the submission, read every comment before replying. HN rewards thoughtful, don't rush.
- **X replies/quote-tweets** — quote-tweets matter more than replies for reach. Thank thoughtful ones, don't dunk on dumb ones.
- **Reddit comments** — Reddit auto-sorts by controversial early; skim, respond to top-level questions only.
- **Traffic** — if Pages analytics is wired, watch `plugin.ashlr.ai` referrers. Otherwise `gh api repos/.../traffic/views` (14-day window, updates hourly).
- **`/ashlr-doctor` error reports** — if someone files an install issue, ask them to paste `/ashlr-doctor` output. Saves 10 back-and-forths.

---

## Rehearsed answers — the 10 questions you'll definitely get

Keep these in a scratchpad. Don't copy-paste verbatim; rephrase slightly per thread so it doesn't feel templated.

**Q: "Why not just make this a paid product?"**
I wanted the mechanism auditable. WOZCODE exists, it's polished, people happily pay — I'm not trying to eat their lunch. This is for the people who want to see every line of code that's rewriting their MCP traffic.

**Q: "Does this work with Opus?"**
Yes. Savings math is model-agnostic (characters in, tokens out); pricing math respects `ASHLR_PRICING_MODEL` so the `$` in `/ashlr-savings` reflects whatever plan you're on. Opus users see the biggest dollar savings because Opus is the most expensive per-token.

**Q: "Is it spying on me / phoning home?"**
No. `git grep -E 'posthog|fetch.*\.(com|io)|analytics'` on the repo — nothing outbound. The one exception is `/ashlr-doctor`, which hits GitHub's public releases API to check if you're behind. That's a deliberate user-invoked action, not background.

**Q: "How does this compare to WOZCODE?"**
Same shape: tri-agent, Read/Grep/Edit redirect, commit attribution, edit-batching, status line. Mine adds SQL + Bash + Tree MCP tools and a baseline scanner. Mine is MIT, no account, zero telemetry. Theirs is more polished and has a real support channel. Both valid.

**Q: "Does the tokenizer count match Anthropic exactly?"**
No — Anthropic doesn't publish theirs. I use tiktoken cl100k_base as a proxy, which is ~12.9% more accurate than chars/4 on code (measured). I'd rather ship an honest proxy than a fake-precise estimate.

**Q: "Will it work with Cursor / Zed / Windsurf?"**
The MCP servers will — you can wire them up manually by pointing your editor's MCP config at `servers/*.ts`. The **plugin-format install** (marketplace, hooks, commands) is Claude-Code-only because nobody else implements that yet.

**Q: "Why Bun? I don't have Bun."**
Bun starts MCP servers faster than Node and the install story is cleaner. `curl -fsSL https://bun.sh/install | bash` — 5 seconds. If this is a hard blocker for someone, open an issue; Node compat is a reasonable ask but not free to maintain.

**Q: "Show me the real savings on my own code."**
`/ashlr-benchmark` runs the harness against the current working directory. Real files, real numbers, reproducible.

**Q: "Is the -79.5% figure cherry-picked?"**
It's the mean across files ≥ 2 KB in the benchmark corpus. Smaller files see 0% because `snipCompact` has a 2 KB threshold — I could have dropped the threshold to juice the number, I didn't.

**Q: "What's the genome thing?"**
`.ashlrcode/genome/` is a sectioned project spec (markdown files, ~one per concern). `ashlr__grep` returns only the task-relevant sections instead of grepping the whole tree. v0.5 adds a scribe that keeps the genome current as you work. Run `/ashlr-genome-init` to try it.

---

## What to NOT do

These matter more than the positive advice above. Re-read before posting.

1. **Don't engage trolls.** Every launch thread gets one "this is garbage / reinventing the wheel / you should just use X" comment. Do not reply. Replying legitimizes it and sinks the thread. Move on.
2. **Don't overpromise.** The numbers are specific: −79.5% on files ≥ 2 KB. Don't let excitement turn it into "80% faster" or "80% cheaper" — those mean different things.
3. **Don't vanity-name-drop.** No "I used this at $BIG_CO" if you didn't. No "endorsed by X" unless X actually endorsed it. Credibility is cheap to lose.
4. **Don't shit on WOZCODE.** They built the pattern first. Frame as "open-source equivalent," never "killer" or "replacement." You'll get WOZCODE users trying it precisely because you were respectful.
5. **Don't amend the HN post after it's live.** Comments will reference earlier phrasing. If you find a typo, note it in a comment on your own thread instead.
6. **Don't reply to every comment.** Reply to substantive questions, thoughtful critiques, and install issues. Skip "nice!" and "cool project" — a like is fine.
7. **Don't cross-link your own Reddit post from X within the first hour.** Looks like brigading. Wait until it has organic traction.
8. **Don't add an "upvote please" anywhere.** Instant credibility death on HN/Reddit.
9. **Don't argue about the benchmark methodology in public.** If someone says the benchmark is bad, ask them to file an issue with a proposed improvement. Takes the heat off the thread and usually produces better data.
10. **Don't launch on a day you can't monitor for 12 hours.** If you post and disappear, questions go unanswered and the thread dies.

---

## Sample reply templates

Adapt, don't paste verbatim.

**Install issue:**
> Can you paste the output of `/ashlr-doctor`? That'll tell me whether it's an MCP registration issue, a bun version thing, or a plugin-path problem. If doctor itself fails, `bun --version` + `ls ~/.claude/plugins/cache/ashlr-marketplace/ashlr` is the next step.

**Skeptical about numbers:**
> Fair question. `/ashlr-benchmark` runs the harness on your working directory and prints the raw per-file savings. If it comes out very different from the −79.5% figure, I'd genuinely like the dataset — open an issue.

**"Why should I trust you?"**
> You shouldn't, really — that's the whole point of MIT + zero telemetry. Source is 100% readable, `git grep posthog` on the repo returns nothing, stats never leave your disk. If you find anything that contradicts that, it's a CVE and I want to know.

**"Doesn't WOZCODE already do this?"**
> Yes, and they did it first. Ashlr is the open-source equivalent — same shape, auditable source, no account, zero telemetry. If WOZCODE's polish is worth $20/week to you, use WOZCODE. This is for people who want to read every line.

---

## After the launch

- Merge any install-issue PRs within 48h if they're clean.
- Write a "lessons learned" note in `docs/launch/post-mortem.md` once the dust settles — which number surprised you, which question you weren't ready for, what you'd change.
- If traction is real, ask two or three early users for a short quote — not testimonials, just "what surprised you." Use in future posts.
- Don't re-launch for at least 3 months. New major version = new launch; point release = don't.
