# Using ashlr-plugin with Phantom

This page covers running the plugin under Phantom Secrets (`phantom exec`, `phm_` placeholders) and in front of a model gateway such as LiteLLM. For the full provider and gateway rules see [llm-providers.md](llm-providers.md) and [embeddings-gateway.md](embeddings-gateway.md).

## Running under `phantom exec`

Start the agent, or a plugin script, as `phantom exec -- <cmd>`, for example `phantom exec -- claude`. Phantom then does three things:
- It gives the child fresh `phm_` session placeholders instead of real keys, for example in `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- It points `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` at a local proxy: `http://127.0.0.1:<port>/<route>/_phantom/<token>/`.
- It sets `PHANTOM_PROXY_PORT`, `PHANTOM_PROXY_TOKEN` and `PHANTOM_SESSION_KEYS`.

The plugin sends the placeholder unchanged, and the proxy swaps in the real key on the way out. The proxy URL is loopback http, so it passes the plugin's base URL rules.

How the plugin behaves in a session:
- **Detection by name and prefix only.** `servers/_phantom-exec.ts` detects a session from variable names, the `phm_` and `phm:` prefixes, and the base URL host and port. It never reads or prints a key, and it redacts the proxy token from any URL it reports.
- **The doctor reports the session.** `/ashlr-doctor` shows a `phantom exec` line and warns, without values, about two cases: a `phm_` placeholder outside a session, and a placeholder whose base URL does not point at the session's proxy.
- **The benchmark skips unusable keys.** `run-benchmark --validate-tokenizer` skips its API sample when the key would not work, and says why.
- **`phm:` references are never resolved.** A `phm:` reference in a key variable is not resolved and is never sent. Run under `phantom exec` so the variable holds a placeholder instead.
- Do not use `phantom reveal` to put a real key into the environment for the plugin.

## Settings that exist

| Variable | Default | What it is |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic root, without `/v1` |
| `ANTHROPIC_API_KEY` | unset | Anthropic key, or a `phm_` placeholder under `phantom exec` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible root, with `/v1` |
| `OPENAI_API_KEY` | unset | OpenAI key, or a `phm_` placeholder |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama: `host`, `host:port`, `:port` or a full URL; keyless |
| `ASHLR_LLM_URL` | `http://127.0.0.1:1234/v1` | Local OpenAI-compatible server for summarization, orient and genome merging |
| `ASHLR_LLM_KEY` | `local-llm` | Bearer for `ASHLR_LLM_URL` |
| `ASHLR_LLM_MODEL` | `qwen/qwen3-coder-30b@8bit` | Model name for `ASHLR_LLM_URL` |
| `ASHLR_API_URL` | `https://api.ashlr.ai` | Ashlr cloud API (Pro) |
| `ASHLR_PRO_TOKEN` | unset | Ashlr Pro token |
| `ASHLR_EMBED_URL`, `ASHLR_EMBED_FORMAT=openai`, `ASHLR_EMBED_KEY`, `ASHLR_EMBED_MODEL` | Ollama format | Opt-in OpenAI-compatible embeddings ([embeddings-gateway.md](embeddings-gateway.md)) |
| `ASHLR_GATEWAY_STRICT=1`, `ASHLR_GATEWAY_HOSTS` | off | Strict allowlist for any call that carries a key |

The base rules apply to calls that carry a key, even without strict mode:
- `https`, or plain `http` only to `127.0.0.1` or `[::1]`. The name `localhost` does not count.
- No credentials in the URL.
- No redirects followed.

A refused URL makes no request, and the refusal names only the scheme, host and port.

## LiteLLM

If a LiteLLM proxy sits between the plugin and the providers, use LiteLLM 1.83.0 or newer, never 1.82.7 or 1.82.8.

- **Why 1.83.0:** `litellm` 1.82.7 and 1.82.8 on PyPI were compromised releases that carried credential-stealing code (GHSA-5mg7-485q-xm76, March 2026). 1.83.0, published to PyPI on 2026-03-31, was the first clean release, built by LiteLLM's rebuilt release pipeline ([LiteLLM security update](https://docs.litellm.ai/blog/security-update-march-2026)).
- **Use a current release, not just 1.83.0.** Later advisories were fixed in later releases (for example GHSA-3cv6-jpf6-8222). On 2026-10-19 the current PyPI release was 1.106.0. Check LiteLLM's security advisories before you pick or upgrade a version.
- **Install it verifiably.** Use a hash-pinned install (`pip install --require-hashes -r requirements.txt`) or the official `ghcr.io/berriai/litellm` image, checked with `cosign verify` as LiteLLM's README shows. Run it in a container that does not mount your home directory or dotfiles.
- Keep the provider keys on the LiteLLM side. Give the agent only the proxy URL and, if the proxy needs one, a proxy key that is separate from the provider keys.

To route the plugin's local-provider calls through LiteLLM, set `ASHLR_LLM_URL=http://127.0.0.1:4000/v1` (LiteLLM's default port) and `ASHLR_LLM_KEY` to the proxy key. For a remote LiteLLM, use `https://` and, with `ASHLR_GATEWAY_STRICT=1`, list its exact `host:port` in `ASHLR_GATEWAY_HOSTS`.

## What is tested

Session detection, the doctor line, the benchmark skip and the URL rules are covered by tests against local stub servers (`__tests__/phantom-exec.test.ts`, `__tests__/doctor-phantom.test.ts`, `__tests__/gateway-target.test.ts`). The plugin has not been tested against a live Phantom session or a live LiteLLM proxy here.
