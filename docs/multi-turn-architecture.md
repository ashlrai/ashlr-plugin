# Multi-Turn Recompression Architecture

## Phase 1: What Claude Code Exposes to Plugins

### Hooks Available

Claude Code's plugin hook system (as of v1.25 investigation, April 2026) exposes four hook events:

| Hook | When it fires | Plugin sees |
|------|---------------|-------------|
| `SessionStart` | Once at session open | stdin: `{}` (no payload). `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT` via env. |
| `PreToolUse` | Before every tool call | stdin: `{ tool_name, tool_input }` |
| `PostToolUse` | After every tool call | stdin: `{ tool_name, tool_input, tool_result }` |
| `SessionEnd` | Once at session close | stdin: `{}` |

### What's NOT Exposed

**Critical finding: no `PreCompletion` / `PreModel` hook exists.**

Claude Code does NOT expose:
- A hook that fires before the LLM is invoked with the full conversation.
- The conversation history (prior turns' messages, tool results, assistant text).
- Any `prompts/list` MCP surface with history-aware context.
- A hook that can mutate or summarize the in-flight context window before model invocation.
- Total token count for the current context.

The only writable surface is `additionalContext` in `PostToolUse` and `SessionStart` responses, which is appended (never replaces) the context window.

### What IS Possible as Pure Plugin Code

1. **Result size tracking**: `PostToolUse` provides `tool_result` content, so we can measure every tool result's byte size as it leaves the hook.
2. **Per-turn freshness modeling**: Since we know when each result was emitted (by recording it at `PostToolUse` time), we can estimate staleness by counting subsequent tool calls.
3. **Nudge injection**: `additionalContext` from `PostToolUse` is injected into the agent's next turn context — not the full history, but visible to the model in the next request.
4. **Session-scoped JSONL log**: `~/.ashlr/session-history/<sessionId>.jsonl` can store a running record of every ashlr tool result emitted, enabling staleness queries at any later point in the session.

### The Fundamental Gap

A true "stale result rewrite" would require intercepting the conversation array that Claude Code assembles before sending to Anthropic. This array includes all prior tool results verbatim. Without a `PreModel` hook that exposes and allows mutation of this array, the plugin cannot truncate or summarize old results.

**Verdict: Phase 3 (true rewrite) is NOT possible with current Claude Code.** The 20-40% savings estimate is contingent on Anthropic exposing a `PreModel` hook in a future release. Until then, the plugin can deliver 5-10% improvement through visibility + user-driven recompression (Phase 2).

---

## Phase 2: What We Build Now

### Architecture Overview

```
PostToolUse (any ashlr__* or Read/Grep call)
    └─> posttooluse-stale-result.ts
            ├── writes to servers/_history-tracker.ts
            │       └── ~/.ashlr/session-history/<sessionId>.jsonl
            └── checks stale byte threshold
                    └── if >50KB stale → additionalContext nudge (once/session)

/ashlr-compact (slash command)
    └─> reads session-history JSONL
    └─> identifies results >5 turns old
    └─> prints savings estimate to user
    └─> injects additionalContext to re-run stale reads

orient-nudge-hook.ts (extended)
    └─> checks stale result total
    └─> injects stale-accumulation nudge (once/session, threshold 50KB)
```

### Freshness Decay Model

Turn delta is measured in subsequent tool calls (not wall-clock time) because "turns" in LLM context are tool-call boundaries.

| Turns since result emitted | Freshness score |
|---------------------------|-----------------|
| 0–4 | 1.0 (fresh) |
| 5–14 | 0.5 (stale) |
| 15+ | 0.2 (very stale) |

These starting coefficients are intentionally conservative. v1.26 will tune via telemetry from `multi_turn_stale_estimate` events.

### Session ID Strategy

Uses `CLAUDE_SESSION_ID` (available in hook env) when present, falling back to the same `derivedSessionId` pattern established in `session-start.ts`. This ensures history files match across PostToolUse calls within the same session.

---

## Phase 3: What's Needed from Claude Code

For true conversation-history recompression, Anthropic would need to add a `PreModel` hook with:

```typescript
// Hypothetical future hook contract
interface PreModelPayload {
  messages: ConversationMessage[];  // full history
  systemPrompt: string;
}
interface PreModelOutput {
  messages?: ConversationMessage[]; // mutated history (plugin can compress)
  additionalSystemContext?: string;
}
```

With this, the plugin could:
1. Walk the `messages` array and find `tool_result` entries from ashlr tools.
2. For results older than N turns with no downstream references, replace the content with a stub: `"[ashlr: result summarized — N bytes removed]"`.
3. Return the compressed message array.

Estimated impact once available: 20-40% context reduction on sessions with >20 turns of file-heavy work.

**Request to Anthropic**: add a `PreModel` hook that provides the full `messages` array and allows returning a mutated copy.
