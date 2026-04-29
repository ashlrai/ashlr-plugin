# LLM Provider Hierarchy

ashlr's summarization layer picks the best available LLM automatically. This doc explains the hierarchy, env vars, and costs.

## Provider order (`ASHLR_LLM_PROVIDER=auto`)

```
anthropic  →  onnx  →  local  →  none (truncation fallback)
```

Each provider is tried in order. The first one whose `isAvailable()` returns true is used for the session. If a provider's `summarize()` throws at runtime, the output falls back to `snipCompact` truncation (never crashes, never blocks).

## Providers

### anthropic (default winner)

**Model:** `claude-haiku-4-5-20251001`

**Availability:** `ANTHROPIC_API_KEY` env var, OR Claude Code's credential store at `~/.claude/.credentials.json` (written automatically when you log in to Claude Code — no extra setup needed).

**Cost:** $0.80/MTok input + $4.00/MTok output. A typical 16KB→500-byte summarization uses ~4K in + ~500 out ≈ $0.005.

**Timeout:** 15 seconds per call.

### onnx (stubbed in v1.22)

**Model:** Xenova/distilbart-cnn-6-6 (text summarization, ~300MB)

**Status:** Stubbed. `isAvailable()` always returns false in this release. Model files can be pre-downloaded with:

```bash
bun run scripts/install-onnx-model.ts
```

The inference pipeline will be wired in a future sprint. Once available, ONNX runs fully offline at $0 cost.

**Availability when implemented:** `onnxruntime-node` installed (optional dep) AND model at `~/.ashlr/models/distilbart/`.

### local

Connects to an OpenAI-compatible server (LM Studio, Ollama, etc.).

**Availability:** Pings `GET {ASHLR_LLM_URL}/models` — responds 200 within 2s. Result cached for 60s.

**Env vars:**

| Var | Default | Purpose |
|-----|---------|---------|
| `ASHLR_LLM_URL` | `http://localhost:1234/v1` | Base URL of the local server |
| `ASHLR_LLM_KEY` | `local-llm` | Bearer token (most local servers don't validate) |
| `ASHLR_LLM_MODEL` | `qwen/qwen3-coder-30b@8bit` | Model name to request |

**Cost:** $0 (local inference).

### none

Selected when no other provider is available. `summarize()` throws immediately, and the caller falls back to `snipCompact` truncation with an `[ashlr · LLM unreachable, fell back to truncation]` note.

## Controlling provider selection

```bash
# Env var (set in shell profile or .env)
export ASHLR_LLM_PROVIDER=auto        # default: try each in order
export ASHLR_LLM_PROVIDER=anthropic   # force Anthropic; throw if unavailable
export ASHLR_LLM_PROVIDER=local       # force local LM Studio / Ollama
export ASHLR_LLM_PROVIDER=off         # disable summarization entirely
```

## Telemetry

Every summarization call emits a `llm_summarize_provider_used` event to `~/.ashlr/session-log.jsonl`:

```jsonl
{"ts":"...","event":"tool_call","tool":"ashlr__read","provider":"anthropic","latency_ms":342,"in_tokens":4096,"out_tokens":487,"fellBackToSnipCompact":false,"llmCostUsd":0.00523}
```

Use `/ashlr-savings` or `/ashlr-dashboard` to view aggregated stats.

## Diagnosing provider selection

```bash
/ashlr-doctor
```

The "runtime state" section reports which provider would be selected and any availability issues.

## Architecture

Implementation lives in `servers/_llm-providers/`:

| File | Purpose |
|------|---------|
| `types.ts` | `LlmProvider` interface |
| `anthropic.ts` | Anthropic Haiku 4.5 via Messages API |
| `onnx.ts` | ONNX local inference (stubbed) |
| `local.ts` | OpenAI-compat local LLM |
| `index.ts` | `selectProvider()` + `summarizeIfLarge()` facade |

`servers/_summarize.ts` re-exports `summarizeIfLarge` from `index.ts` — all existing callers are unchanged.
