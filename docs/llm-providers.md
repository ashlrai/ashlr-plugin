# LLM Provider Hierarchy

ashlr's summarization layer picks the best available LLM automatically. This doc explains the hierarchy, where file contents go, the env vars, and costs.

Summarization only runs on output above the threshold (16,384 bytes by default) and only when the call does not pass `bypassSummary: true`. Smaller output is returned without any model call.

## Provider order (`ASHLR_LLM_PROVIDER=auto`)

```
[local, only when ASHLR_LLM_URL is set]  →  anthropic  →  cloud  →  onnx  →  local  →  none (truncation fallback)
```

`selectProvider()` in `servers/_llm-providers/index.ts` returns the first provider whose `isAvailable()` is true. Setting `ASHLR_LLM_URL` is read as "use my endpoint": if that endpoint answers, it wins over Anthropic. If the selected provider's `summarize()` throws at runtime, the output falls back to `snipCompact` truncation; it does not move on to the next provider, and it never crashes or blocks the tool call.

## Where file contents go

`auto` is the default, so the provider that wins decides where the text being summarized is sent:

| Selected provider | When `auto` picks it | Content goes to |
|---|---|---|
| `local` (explicit) | `ASHLR_LLM_URL` is set and its `/models` endpoint answers | That URL |
| `anthropic` | `ANTHROPIC_API_KEY` is set, or Claude Code's `~/.claude/.credentials.json` holds an OAuth token and `ANTHROPIC_BASE_URL` is the default | `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`) |
| `cloud` | `~/.ashlr/pro-token` exists and was written in the last 24 hours | `ASHLR_API_URL` (default `https://api.ashlr.ai`) `/llm/summarize` |
| `onnx` | `onnxruntime-node` is installed and the model is in `~/.ashlr/models/distilbart/` | Nowhere: runs in process |
| `local` (default) | Its endpoint answers, `http://127.0.0.1:1234/v1` unless configured | That endpoint |
| `none` | Nothing else is available | Nowhere: `snipCompact` truncation |

This means a Claude Code user who is logged in, with no other configuration, gets summaries from Anthropic Haiku. To keep summarization on the machine, set `ASHLR_LLM_PROVIDER=local` (or `onnx`), or set `ASHLR_LLM_PROVIDER=off` to disable it. Telemetry is a separate, opt-in setting (`ASHLR_TELEMETRY=on`); see [telemetry.md](telemetry.md).

## Providers

### anthropic

**Model:** `claude-haiku-4-5-20251001`

**Availability:** `ANTHROPIC_API_KEY` env var, OR Claude Code's credential store at `~/.claude/.credentials.json` (written when you log in to Claude Code). The Claude Code OAuth token is only sent to the default Anthropic host, never to a custom `ANTHROPIC_BASE_URL` such as a LiteLLM proxy; with a custom base URL, only `ANTHROPIC_API_KEY` counts.

**Cost:** $0.80/MTok input + $4.00/MTok output. A typical 16KB→500-byte summarization uses ~4K in + ~500 out ≈ $0.005.

**Timeout:** 15 seconds per call.

### cloud (Pro and Team)

Calls the hosted summarizer at `{ASHLR_API_URL}/llm/summarize` with the Pro token as a bearer token. See [Hosted summarization](https://plugin.ashlr.ai/docs/pro/hosted-summarization).

**Availability:** `~/.ashlr/pro-token` is non-empty and was modified within the last 24 hours. `auto` only reaches it when no Anthropic credential is available.

**Timeout:** 5 seconds per call.

### onnx

**Model:** Xenova/distilbart-cnn-6-6 (text summarization, ~300MB). Runs fully offline at $0 cost. Input is truncated to the first 4,000 characters.

**Availability:** `onnxruntime-node` is not installed with ashlr-plugin. Install it yourself, and put the model files at `~/.ashlr/models/distilbart/`.

```bash
bun add onnxruntime-node
bun run install-onnx-model
```

npm 11 does not run that package's install script unless you allow it. In a project, add this to `package.json` and install again:

```json
"allowScripts": {
  "onnxruntime-node": true
}
```

A global install has no project `package.json`, so allow the script on the command line:

```bash
npm install -g onnxruntime-node --allow-scripts=onnxruntime-node
```

### local

Connects to an OpenAI-compatible server (LM Studio, Ollama, etc.).

**Availability:** Pings `GET {ASHLR_LLM_URL}/models` — responds 200 within 2s. Result cached for 60s.

**Env vars:**

| Var | Default | Purpose |
|-----|---------|---------|
| `ASHLR_LLM_URL` | `http://127.0.0.1:1234/v1` | Base URL of the local server |
| `ASHLR_LLM_KEY` | `local-llm` | Bearer token (most local servers don't validate) |
| `ASHLR_LLM_MODEL` | `qwen/qwen3-coder-30b@8bit` | Model name to request |

With `ASHLR_PRO_TOKEN` set and no `ASHLR_LLM_URL`, the local provider's endpoint becomes `{ASHLR_API_URL}/llm` instead.

**Cost:** $0 (local inference).

### none

Selected when no other provider is available, or with `ASHLR_LLM_PROVIDER=off`. Output falls back to `snipCompact` truncation with an LLM fallback note.

## Controlling provider selection

```bash
# Env var (set in shell profile or .env)
export ASHLR_LLM_PROVIDER=auto        # default: try each in order
export ASHLR_LLM_PROVIDER=anthropic   # force Anthropic; falls back to truncation if unavailable
export ASHLR_LLM_PROVIDER=cloud       # force the hosted Pro summarizer
export ASHLR_LLM_PROVIDER=onnx        # force in-process ONNX
export ASHLR_LLM_PROVIDER=local       # force local LM Studio / Ollama
export ASHLR_LLM_PROVIDER=off         # disable summarization entirely
```

## Telemetry

Every summarization call that reaches a provider appends a `llm_summarize_provider_used` event to the local `~/.ashlr/session-log.jsonl` (set `ASHLR_SESSION_LOG=0` to turn the log off). Nothing is uploaded:

```jsonl
{"ts":"...","agent":"ashlr-mcp","event":"llm_summarize_provider_used","tool":"ashlr__read","cwd":"...","session":"...","provider":"anthropic","latency_ms":342,"in_tokens":4096,"out_tokens":487,"fellBackToSnipCompact":false,"llmCostUsd":0.00523}
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
| `cloud.ts` | Hosted Pro summarizer at `api.ashlr.ai` |
| `onnx.ts` | In-process ONNX inference |
| `local.ts` | OpenAI-compat local LLM |
| `index.ts` | `selectProvider()` + `summarizeIfLarge()` facade |

`servers/_summarize.ts` re-exports `summarizeIfLarge` from `index.ts` — all existing callers are unchanged.

## Strict gateway targets (opt-in)

Off by default. Set `ASHLR_GATEWAY_STRICT=1` to restrict where a model call that carries a key (`Authorization` or `x-api-key`) may go:

- `127.0.0.1` or `[::1]` by IP literal, over http or https on any port (a local LiteLLM, LM Studio or Ollama). `localhost` by name does not count.
- https to an exact `host:port` listed in `ASHLR_GATEWAY_HOSTS`, comma-separated, for example `ASHLR_GATEWAY_HOSTS=litellm.internal:4000,gw.example.com:443`. Port 443 is assumed when the URL has none. An entry without a port makes every listed target refuse until it is fixed.
- https to the built-in provider hosts on 443: `api.anthropic.com`, `api.openai.com`, `api.ashlr.ai`.

In strict mode, credentials in the URL are refused and redirects are never followed: a 3xx is a refusal, because fetch forwards a custom header such as `x-api-key` to the redirect target. A refused call fails the same way a network error does, so summarization falls back and orient and genome merging fall back to their offline paths. Refusal messages name the scheme, host and port only, never the key, path or query.

Covered calls: the local provider (`ASHLR_LLM_URL`, availability probe and chat), the legacy internal `endpointOverride` path, the Anthropic and cloud providers, token measurement, `ashlr__orient`'s LLM call, `ashlr__genome_consolidate`'s LLM merge, and the genome auto-consolidate reachability probes.

`ashlr__orient`, `ashlr__genome_consolidate`, the local and cloud providers (`ASHLR_LLM_URL`, `ASHLR_API_URL`), the Anthropic summarizer, token measurement and the genome auto-consolidate Anthropic and OpenAI probes apply the base rules even without strict mode (for the Anthropic and OpenAI calls the URL is `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`). For orient and genome, the endpoint comes only from `ASHLR_LLM_URL` (default `http://127.0.0.1:1234/v1`), which must be https or http to `127.0.0.1` / `[::1]`, with no credentials in the URL and no redirects followed. A tool argument cannot change it; genome's `model` argument only chooses `none` (offline) or LLM merging. Keyless calls (Ollama setup, `ASHLR_EMBED_URL` in its default Ollama format) are unchanged. The opt-in OpenAI-compatible embedding mode follows these rules; see [embeddings-gateway.md](embeddings-gateway.md).
