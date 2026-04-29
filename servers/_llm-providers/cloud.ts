/**
 * Cloud LLM provider — ashlr hosted Anthropic Haiku proxy.
 *
 * For Pro users who don't have their own Anthropic API key. The backend at
 * POST /llm/summarize handles billing, rate limiting, and cost caps so the
 * user pays a flat $12/mo instead of managing Anthropic credits.
 *
 * Endpoint: ASHLR_API_URL (default: https://api.ashlr.ai) + /llm/summarize
 * Auth:     Authorization: Bearer <contents of ~/.ashlr/pro-token>
 * Timeout:  5s (Pro users expect fast responses)
 *
 * Error handling:
 *   429 (rate-limit OR daily cap)  → throws CloudRateLimitError (dispatcher falls through)
 *   5xx                            → throws generic Error (dispatcher falls through)
 *   network / timeout              → throws generic Error (dispatcher falls through)
 */

import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { LlmProvider, LlmSummarizeResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARIZE_TIMEOUT_MS = 5_000;
/** Cache isAvailable() result for 24h — token presence is stable within a session. */
const AVAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Typed error for rate-limit / daily-cap responses
// ---------------------------------------------------------------------------

export class CloudRateLimitError extends Error {
  /** Value of the Retry-After header when present (seconds), else undefined. */
  readonly retryAfterSecs: number | undefined;
  /** HTTP status returned by the backend (always 429). */
  readonly statusCode: number;

  constructor(message: string, statusCode: number, retryAfterSecs?: number) {
    super(message);
    this.name = "CloudRateLimitError";
    this.statusCode = statusCode;
    this.retryAfterSecs = retryAfterSecs;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME ?? homedir();
}

function proTokenPath(): string {
  return join(home(), ".ashlr", "pro-token");
}

function apiBase(): string {
  return (process.env.ASHLR_API_URL ?? "https://api.ashlr.ai").replace(/\/$/, "");
}

async function readProToken(): Promise<string | null> {
  const path = proTokenPath();
  if (!existsSync(path)) return null;
  try {
    const token = (await readFile(path, "utf-8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Availability cache
// ---------------------------------------------------------------------------

let _availCache: { available: boolean; expiresAt: number } | null = null;

/** Reset availability cache (test hook). */
export function _resetCloudAvailabilityCache(): void {
  _availCache = null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const cloudProvider: LlmProvider = {
  name: "cloud",

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (_availCache && now < _availCache.expiresAt) return _availCache.available;

    const path = proTokenPath();
    let available = false;

    if (existsSync(path)) {
      try {
        // Lightweight check: file exists AND was validated within last 24h
        // (Track P1 will upgrade this to full JWT validation when it lands).
        const s = await stat(path);
        const token = (await readFile(path, "utf-8")).trim();
        available = token.length > 0 && now - s.mtimeMs < AVAIL_CACHE_TTL_MS;
      } catch {
        available = false;
      }
    }

    _availCache = { available, expiresAt: now + AVAIL_CACHE_TTL_MS };
    return available;
  },

  async summarize(
    text: string,
    prompt: string,
    opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult> {
    const token = await readProToken();
    if (!token) throw new Error("cloud provider: no pro-token found");

    const url = `${apiBase()}/llm/summarize`;
    const maxTokens = opts?.maxTokens;
    const t0 = Date.now();

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SUMMARIZE_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          text,
          systemPrompt: prompt,
          toolName: "ashlr__cloud",
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    // 429 — rate limit (per-minute bucket) OR daily cap exhausted
    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      const retryHeader = res.headers.get("retry-after");
      const retryAfterSecs = retryHeader ? parseInt(retryHeader, 10) : undefined;
      throw new CloudRateLimitError(
        `Cloud LLM rate limit: ${body.slice(0, 200)}`,
        429,
        Number.isFinite(retryAfterSecs) ? retryAfterSecs : undefined,
      );
    }

    // 5xx — backend error; let dispatcher fall through to onnx/local/snipCompact
    if (res.status >= 500) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloud LLM error ${res.status}: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Cloud LLM error ${res.status}: ${body.slice(0, 200)}`);
    }

    const latencyMs = Date.now() - t0;

    const j = (await res.json()) as {
      summary?: string;
      inputTokens?: number;
      outputTokens?: number;
    };

    if (!j.summary || j.summary.trim().length === 0) {
      throw new Error("Cloud LLM: empty summary in response");
    }

    return {
      output: j.summary.trim(),
      inTokens: j.inputTokens ?? 0,
      outTokens: j.outputTokens ?? 0,
      latencyMs,
    };
  },
};
