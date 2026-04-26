/**
 * Anthropic Haiku 4.5 provider.
 *
 * Availability: checks ANTHROPIC_API_KEY env var, then falls back to reading
 * ~/.claude/.credentials.json (where Claude Code stores its OAuth token).
 *
 * On availability: returns true + caches.
 * On network failure: throws so the dispatcher can fall through to next provider.
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { LlmProvider, LlmSummarizeResult } from "./types.ts";

const MODEL = "claude-haiku-4-5-20251001";
const API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

function home(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Try to read the Anthropic API key from Claude Code's credential store.
 * Claude Code writes OAuth tokens to ~/.claude/.credentials.json under the
 * `claudeAiOauth` key. We extract `accessToken` from that entry.
 *
 * Returns null if the file doesn't exist or doesn't contain an API key shape.
 */
async function readClaudeCredentials(): Promise<string | null> {
  try {
    const path = join(home(), ".claude", ".credentials.json");
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Claude Code OAuth shape: { claudeAiOauth: { accessToken: "..." } }
    const oauth = parsed["claudeAiOauth"];
    if (oauth && typeof oauth === "object") {
      const token = (oauth as Record<string, unknown>)["accessToken"];
      if (typeof token === "string" && token.length > 0) return token;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve API key: env var takes priority over credential file. */
async function resolveApiKey(): Promise<string | null> {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim().length > 0) return env.trim();
  return readClaudeCredentials();
}

// Cache availability check for the process lifetime (key presence is stable).
let _availableCache: boolean | null = null;

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  async isAvailable(): Promise<boolean> {
    if (_availableCache !== null) return _availableCache;
    const key = await resolveApiKey();
    _availableCache = key !== null && key.length > 0;
    return _availableCache;
  },

  async summarize(
    text: string,
    prompt: string,
    opts?: { maxTokens?: number },
  ): Promise<LlmSummarizeResult> {
    const apiKey = await resolveApiKey();
    if (!apiKey) throw new Error("Anthropic: no API key available");

    const maxTokens = opts?.maxTokens ?? 800;
    const t0 = Date.now();

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/v1/messages`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          system: prompt,
          messages: [{ role: "user", content: text }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const latencyMs = Date.now() - t0;
    const j = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const output = (j.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    if (!output) throw new Error("Anthropic: empty response");

    const inTokens = j.usage?.input_tokens ?? 0;
    const outTokens = j.usage?.output_tokens ?? 0;

    return { output, inTokens, outTokens, latencyMs };
  },
};

/** Test hook: reset the availability cache (so tests can toggle ANTHROPIC_API_KEY). */
export function _resetAnthropicAvailabilityCache(): void {
  _availableCache = null;
}
