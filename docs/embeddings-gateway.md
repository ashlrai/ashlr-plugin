# Embeddings through LiteLLM or another OpenAI-compatible endpoint

This is opt-in and off by default. Without `ASHLR_EMBED_FORMAT=openai`, nothing changes. `ASHLR_EMBED_URL` keeps its Ollama format (`{ model, prompt }` in, `{ embedding }` out), sends no key, and the BM25 embedder still runs when no URL is set.

## Turning it on

```sh
ASHLR_EMBED_FORMAT=openai
ASHLR_EMBED_URL=http://127.0.0.1:4000/v1     # a local LiteLLM proxy, for example
ASHLR_EMBED_MODEL=text-embedding-3-small     # whatever model name your gateway serves
ASHLR_EMBED_KEY=sk-...                       # optional
```

With the format set, the plugin POSTs `{ "model": ..., "input": <text> }` to `<ASHLR_EMBED_URL>/embeddings` and reads `data[0].embedding`. A URL that already ends in `/embeddings` is used as is. `ASHLR_EMBED_KEY` is sent as `Authorization: Bearer <key>` and only in this mode. In the Ollama format it is ignored.

Any failure falls back to the built-in BM25 embedder, as the Ollama path does. Failures include a refused URL, a timeout after 5 s, an error status, and a body without a numeric `data[0].embedding`.

## Gateway rules

These are the same rules as the other keyed model calls (see [llm-providers.md](llm-providers.md)):

- The URL must be https, or plain http only to `127.0.0.1` or `[::1]`. `localhost` by name is refused, as is plain http to any other host.
- Credentials in the URL (`https://user:pass@...`) are refused.
- Redirects are not followed. A 3xx is a refusal, so the key never follows one.
- With `ASHLR_GATEWAY_STRICT=1`, the target must also be loopback, an exact https `host:port` in `ASHLR_GATEWAY_HOSTS`, or a built-in provider host.

A refused URL makes no request.

## Phantom

Under `phantom exec -- <cmd>`, set `ASHLR_EMBED_KEY` to the session's `phm_` placeholder and `ASHLR_EMBED_URL` to the proxy URL for your provider. The proxy URL is `http://127.0.0.1:<port>/...`, so it passes the rules above. The placeholder is sent unchanged and the proxy swaps in the real key on the way out. The plugin never resolves a `phm:` vault reference and never runs `phantom reveal`. If `ASHLR_EMBED_KEY` is a `phm:` reference, no request is made and BM25 is used.

## What is never logged

The embedding call writes nothing to stdout or stderr: not the key, not the text being embedded, and not the response. `scripts/context-status.ts` names an openai-format endpoint as `scheme://host:port` only, so a Phantom session token in the URL path is not printed.

## Caveats

The URL handling, rules and request shape are covered by tests against local stub servers. The plugin has not been tested against a live LiteLLM or Phantom session here. A remote model's vectors have a different dimension than the 256-dim BM25 vectors, as with the existing Ollama mode, so keep one embedder per context database.
