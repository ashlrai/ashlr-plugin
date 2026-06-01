# ashlr × open-model leaderboard bridge

Proves — for **$0**, on local hardware — that an **open-weight model** can drive ashlr's
MCP tools to do real repo work. This is the foundation for getting ashlr onto an
agent leaderboard (target: **HAL / GAIA**, hal.cs.princeton.edu/gaia).

## Why this exists
Hugging Face "by model size" boards rank *raw models* — a tool layer like ashlr can't
enter them. The boards that rank a *scaffold* (HAL, GAIA, Terminal-Bench, SWE-bench) are
where ashlr competes. HAL's GAIA track plots **accuracy vs. tokens/cost**, so the credible,
free, ambitious result is: *"an ashlr-equipped open model reaches a better
accuracy-per-token point than the same model without ashlr."*

## Architecture
```
local open model (Ollama /api/chat, native tool-calling)
        │  bridge.py  (minimal agent loop)
        ▼
mcp Python SDK (stdio)  ──►  ashlr MCP server  (node scripts/bootstrap.mjs servers/_router.ts)
                                   └─ ashlr__grep / ashlr__read / ashlr__ls / ashlr__glob / …
```
No paid APIs, no framework lock-in (the official `mcp` SDK + Ollama only).

## Run
```bash
uv venv --python 3.13 && uv pip install -r requirements.txt
ASHLR_EVAL_MODEL="qwen2.5:72b-instruct-q4_K_M" .venv/bin/python bridge.py
```
`_probe_tools.py` lists the ashlr tools; `_tooltest.py` checks a model's tool-calling.

## Model note (important)
Use an **instruct** model with reliable Ollama tool-calling. Verified locally:
- **qwen2.5:72b-instruct** ✓ emits structured `tool_calls` — bridge works end-to-end.
- **qwen3:32b** ✓ tool-calls, but also emits a `thinking` field (needs handling).
- **qwen2.5-coder:7b** ✗ does *not* use native tool-calling (prints JSON as text) — unusable as-is.

## Verified smoke (qwen2.5:72b-instruct, $0)
Task: "Which file defines `findFuzzyMatch` and its two confidence thresholds?"
→ model called `ashlr__grep` then `ashlr__read` → answered correctly:
`servers/_edit-match.ts`, min score **0.90**, uniqueness margin **0.05**. 2 tool calls, ~5.9K tokens.

## Path to a HAL / GAIA submission (next)
1. Wrap this agent loop as a HAL custom agent (`hal-harness`, github.com/princeton-pli/hal-harness) — its `run()` calls the same MCP-tools + local-model loop. (smolagents `ToolCollection.from_mcp` is an alternative wrapper that also speaks MCP.)
2. Run the **GAIA validation set locally** on an open model — $0.
3. Run the core experiment: **ashlr-ON vs ashlr-OFF**, same model/seed/tasks → report success% (must hold) + median tokens/$ (must drop). Reuse the repo's `bootstrapCI` for confidence bounds.
4. `hal-upload` traces to HF Hub; submit the ashlr-ON run so success is third-party-verified, host the token/$ delta alongside.

### Open risks (verify before investing)
- HAL may have **paused new submissions** (their page mentioned focusing on reliability) — confirm via the repo/Discord.
- A coder/instruct model may **underperform general GAIA** (web/multimodal). If so, target **Terminal-Bench 2.0** or **SWE-bench** coding tracks where the model is in its lane and ashlr's file/terminal tools shine.
- The win is the *A/B delta* (ashlr-on vs off), not the absolute top of the board.
