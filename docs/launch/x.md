# X / Twitter launch post

## Main thread (5 tweets)

**1/ **
I got tired of Claude Code burning through my Max plan in a 4-hour session.

WOZCODE is great but closed + paywalled. So I built an open-source alternative in a weekend.

Mean **−79.5%** token savings on files ≥ 2 KB. MIT. No account.

🔗 plugin.ashlr.ai

---

**2/ **
Three MCP tools replace Claude Code's built-in Read / Grep / Edit:

• `ashlr__read` — snipCompact head + tail, elide the middle the agent never needs
• `ashlr__grep` — genome RAG when a repo has one, ripgrep fallback otherwise
• `ashlr__edit` — applies the edit in place, returns diff summary only

---

**3/ **
The efficiency primitives aren't locked in the plugin.

They live in `@ashlr/core-efficiency` — a separate open-source library that also powers my standalone CLI `ashlrcode`.

One implementation. Two consumers. Evolution in one place.

---

**4/ **
Mirrors WOZCODE's tri-agent pattern:

• ashlr:code (sonnet, main)
• ashlr:explore (haiku, read-only)
• ashlr:plan (haiku, planning)

With explicit delegation rules — 3+ orientation reads → explore; 3+ file changes → plan. That's how the savings compound.

---

**5/ **
Install:

```
/plugin marketplace add masonwyatt23/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
```

Source: github.com/masonwyatt23/ashlr-plugin
Landing: plugin.ashlr.ai

If WOZCODE's $20/week feels right, use WOZCODE. If you want the mechanism in the open, use this. 🏛️

## Standalone single post (if thread is too much)

Built an open-source WOZCODE alternative for Claude Code. Token-efficient Read/Grep/Edit via MCP, mean −79.5% savings on files ≥ 2 KB, MIT, no account.

plugin.ashlr.ai
