/**
 * llm.ts — Cloud LLM summarizer endpoint (Phase 2).
 *
 * POST /llm/summarize
 *   Auth:    Authorization: Bearer <api-token>
 *   Body:    { text, systemPrompt, maxTokens?, toolName }
 *   Returns: { summary, modelUsed, inputTokens, outputTokens, cost }
 *
 * Privacy invariants:
 *   - text and systemPrompt content are NEVER logged.
 *   - ANTHROPIC_API_KEY is NEVER logged or returned in error responses.
 *   - Only byte counts and tool name appear in logs.
 */

import { Hono } from "hono";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { authMiddleware, requireTier } from "../lib/auth.js";
import { checkRateLimitBucket } from "../lib/ratelimit.js";
import { cLlmRequests, hLlmTokens } from "../lib/metrics.js";
import {
  checkDailyCap,
  bumpDailyUsage,
  logLlmCall,
  tryRecordDailyCapNotification,
  getUserById,
} from "../db.js";
import { sendEmail } from "../lib/email.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5";
// Haiku 4.5 pricing per token (as of 2026)
const COST_PER_INPUT_TOKEN  = 1.00 / 1_000_000;  // $1.00 / 1M
const COST_PER_OUTPUT_TOKEN = 5.00 / 1_000_000;  // $5.00 / 1M

const MAX_TEXT_BYTES       = 64 * 1024;  // 64 KB
const MAX_SYSTEM_BYTES     = 2  * 1024;  // 2 KB
const DEFAULT_MAX_TOKENS   = 800;
const CAP_MAX_TOKENS       = 1500;

// Rate limit: 30 requests per minute per token (2 000 ms minimum gap is wrong
// for 30/min; use a sliding-window bucket instead — see ratelimit.ts).
const RATE_LIMIT_BUCKET    = "llm_summarize";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 30;

// ---------------------------------------------------------------------------
// In-memory result cache: SHA-256(toolName + systemPrompt + text + maxTokens)
// → { summary, inputTokens, outputTokens, cost, expiresAt }
// ---------------------------------------------------------------------------

interface CacheEntry {
  summary: string;
  inputTokens: number;
  outputTokens: number;
  expiresAt: number; // epoch ms
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(toolName: string, systemPrompt: string, text: string, maxTokens: number): string {
  return createHash("sha256")
    .update(toolName + "\x00" + systemPrompt + "\x00" + text + "\x00" + String(maxTokens))
    .digest("hex");
}

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCached(key: string, entry: Omit<CacheEntry, "expiresAt">): void {
  cache.set(key, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test helper — clear the in-memory cache. */
export function _clearLlmCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const SummarizeBodySchema = z.object({
  text:         z.string().min(1),
  systemPrompt: z.string().min(1),
  maxTokens:    z.number().int().min(1).max(CAP_MAX_TOKENS).optional(),
  toolName:     z.string().min(1),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const llm = new Hono();

llm.post("/llm/summarize", authMiddleware, async (c) => {
  const user = c.get("user");

  // --- tier gate: pro and team only ---
  const deny = requireTier(c, user, "pro");
  if (deny) return deny;

  // --- rate limit (30 req/min per token) ---
  const rateLimitKey = `${RATE_LIMIT_BUCKET}:${user.api_token}`;
  const allowed = checkRateLimitBucket(rateLimitKey, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);
  if (!allowed) {
    return c.json({ error: "Rate limit exceeded. Max 30 requests per minute." }, 429);
  }

  // --- parse body ---
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = SummarizeBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }

  const { text, systemPrompt, toolName } = parsed.data;
  const maxTokens = parsed.data.maxTokens ?? DEFAULT_MAX_TOKENS;

  // --- size guards ---
  const textBytes = Buffer.byteLength(text, "utf-8");
  if (textBytes > MAX_TEXT_BYTES) {
    return c.json({ error: `text exceeds maximum size of ${MAX_TEXT_BYTES} bytes` }, 413);
  }
  const systemBytes = Buffer.byteLength(systemPrompt, "utf-8");
  if (systemBytes > MAX_SYSTEM_BYTES) {
    return c.json({ error: `systemPrompt exceeds maximum size of ${MAX_SYSTEM_BYTES} bytes` }, 413);
  }

  // --- daily cap check ---
  const cap = checkDailyCap(user.id);
  if (!cap.allowed) {
    // Send once-per-day notification email (best-effort, non-blocking)
    if (tryRecordDailyCapNotification(user.id)) {
      const fullUser = getUserById(user.id);
      if (fullUser) {
        void sendEmail("daily-cap-reached", {
          to:   fullUser.email,
          data: { email: fullUser.email },
        });
      }
    }
    return c.json({ error: "Daily cap reached. Try again tomorrow.", remaining: cap.remaining }, 429);
  }

  // --- cache check ---
  const key = cacheKey(toolName, systemPrompt, text, maxTokens);
  const cached = getCached(key);
  if (cached) {
    logLlmCall({
      userId: user.id,
      toolName,
      inputTokens: cached.inputTokens,
      outputTokens: cached.outputTokens,
      cost: 0,
      cached: true,
    });
    return c.json({
      summary:      cached.summary,
      modelUsed:    "cache",
      inputTokens:  cached.inputTokens,
      outputTokens: cached.outputTokens,
      cost:         0,
    });
  }

  // --- call Anthropic Haiku ---
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Service temporarily unavailable" }, 502);
  }

  let summary: string;
  let inputTokens: number;
  let outputTokens: number;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
      return c.json({ error: "Service temporarily unavailable" }, 502);
    }
    summary      = textBlock.text;
    inputTokens  = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } catch {
    // Do NOT bubble upstream error — it could expose model metadata or API key.
    return c.json({ error: "Service temporarily unavailable" }, 502);
  }

  const cost = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;

  // --- metrics ---
  cLlmRequests.inc({ tier: user.tier });
  hLlmTokens.observe({ type: "input" }, inputTokens);
  hLlmTokens.observe({ type: "output" }, outputTokens);

  // --- persist cache + accounting (best-effort, non-blocking) ---
  setCached(key, { summary, inputTokens, outputTokens });
  bumpDailyUsage(user.id, cost);
  logLlmCall({
    userId: user.id,
    toolName,
    inputTokens,
    outputTokens,
    cost,
    cached: false,
  });

  return c.json({
    summary,
    modelUsed:    MODEL,
    inputTokens,
    outputTokens,
    cost,
  });
});

export default llm;
