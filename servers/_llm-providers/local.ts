/**
 * Local LLM provider — LM Studio / Ollama via OpenAI-compat API.
 *
 * Preserves the existing _summarize.ts local-LLM logic verbatim:
 *   - ASHLR_LLM_URL (default: http://localhost:1234/v1)
 *   - ASHLR_LLM_KEY (default: "local-llm")
 *   - ASHLR_LLM_MODEL (default: "qwen/qwen3-coder-30b@8bit")
 *
 * Availability: pings GET /models at the configured URL; result is cached for
 * 60 seconds so repeated isAvailable() calls don't spam the local server.
 */

import type { LlmProvider, LlmSummarizeResult } from "./types.ts";

function localEndpoint(): string {
  // Mirror the llmEndpoint() logic from the old _summarize.ts — pro-token
  // auto-routing uses the ashlr cloud; explicit ASHLR_LLM_URL wins; default
  // is LM Studio at localhost:1234.
  if (process.env.ASHLR_PRO_TOKEN && !process.env.ASHLR_LLM_URL) {
    const base = process.env.ASHLR_API_URL ?? "https://api.ashlr.ai";
    return `${base}/llm`;
  }
  return process.env.ASHLR_LLM_URL ?? "http://localhost:1234/v1";
}

// Availability cache: { available, expiresAt }
let _availCache: { available: boolean; expiresAt: number } | null = null;
const AVAIL_CACHE_MS = 60_000;

export const localProvider: LlmProvider = {
  name: "local",

  async isAvailable(): Promise<boolean> {
    // Explicit user config wins — if ASHLR_LLM_URL is set, trust the user
    // knows their endpoint works. This both (a) respects intent and
    // (b) avoids requiring test stubs to mock the probe endpoint
    // (`/models`) just to be eligible for the chat path. Same rule for
    // ASHLR_PRO_TOKEN (cloud-routed).
    if (process.env.ASHLR_LLM_URL || process.env.ASHLR_PRO_TOKEN) return true;

    const now = Date.now();
    if (_availCache && now < _availCache.expiresAt) return _availCache.available;

    const url = localEndpoint();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2_000);

    try {
      const res = await fetch(`${url}/models`, {
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${process.env.ASHLR_LLM_KEY ?? "local-llm"}` },
      });
      clearTimeout(t);
      const available = res.ok;
      _availCache = { available, expiresAt: now + AVAIL_CACHE_MS };
      return available;
    } catch {
      clearTimeout(t);
      _availCache = { available: false, expiresAt: now + AVAIL_CACHE_MS };
      return false;
    }
  },

  async summarize(
    text: string,
    prompt: string,
    opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult> {
    const url = localEndpoint();
    const apiKey = process.env.ASHLR_LLM_KEY ?? (
      process.env.ASHLR_PRO_TOKEN && !process.env.ASHLR_LLM_URL
        ? process.env.ASHLR_PRO_TOKEN
        : "local-llm"
    );
    const model = process.env.ASHLR_LLM_MODEL ?? "qwen/qwen3-coder-30b@8bit";
    const maxTokens = opts?.maxTokens ?? 800;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: maxTokens,
          temperature: 0.1,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: text },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`Local LLM error ${res.status}`);

    const latencyMs = Date.now() - t0;
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const output = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!output) throw new Error("Local LLM: empty response");

    const inTokens = j.usage?.prompt_tokens ?? 0;
    const outTokens = j.usage?.completion_tokens ?? 0;

    return { output, inTokens, outTokens, latencyMs };
  },
};

/** Test hook: reset the availability cache so tests can toggle endpoints. */
export function _resetLocalAvailabilityCache(): void {
  _availCache = null;
}
