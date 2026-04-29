/**
 * LLM provider dispatcher and public summarizeIfLarge facade.
 *
 * Provider hierarchy (ASHLR_LLM_PROVIDER=auto, which is the default):
 *   anthropic (ANTHROPIC_API_KEY or ~/.claude/.credentials.json)
 *     → cloud (~/.ashlr/pro-token, calls hosted ashlr Haiku proxy)
 *       → onnx (onnxruntime-node + bundled model — currently stubbed)
 *         → local (LM Studio / Ollama at ASHLR_LLM_URL)
 *           → none (falls back to snipCompact truncation)
 *
 * Anthropic-direct keeps priority over cloud because it's cheaper for users
 * who already have their own key. Cloud serves Pro-but-no-key users.
 *
 * Override with:
 *   ASHLR_LLM_PROVIDER=anthropic  — use Anthropic only (no fallback)
 *   ASHLR_LLM_PROVIDER=cloud      — use cloud proxy only
 *   ASHLR_LLM_PROVIDER=onnx       — use ONNX only
 *   ASHLR_LLM_PROVIDER=local      — use local LLM only (preserves old behavior)
 *   ASHLR_LLM_PROVIDER=off        — disable LLM summarization entirely
 *
 * Cost telemetry: every summarize() call records inTokens/outTokens/cost
 * via logEvent("llm_summarize_provider_used") and recordSaving for
 * LLM cost accounting.
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

import { logEvent } from "../_events.ts";
import { bumpSummarization } from "../_stats.ts";
import { costForLLM } from "../_pricing.ts";
import { anthropicProvider, _resetAnthropicAvailabilityCache } from "./anthropic.ts";
import { onnxProvider } from "./onnx.ts";
import { localProvider, _resetLocalAvailabilityCache } from "./local.ts";
import { cloudProvider, _resetCloudAvailabilityCache } from "./cloud.ts";
import type { LlmProvider, ProviderName } from "./types.ts";

export type { LlmProvider, ProviderName };
export { _resetAnthropicAvailabilityCache, _resetLocalAvailabilityCache, _resetCloudAvailabilityCache };

// ---------------------------------------------------------------------------
// None provider — signals "no LLM available"; caller falls back to snipCompact
// ---------------------------------------------------------------------------

const noneProvider: LlmProvider = {
  name: "none",
  async isAvailable() { return false; },
  async summarize() {
    throw new Error("No LLM provider available; caller should fall back to snipCompact");
  },
};

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/**
 * Select the best available provider given the ASHLR_LLM_PROVIDER env var.
 * Returns noneProvider when nothing is available — never throws.
 */
export async function selectProvider(
  override?: string,
): Promise<LlmProvider> {
  const setting = (override ?? process.env.ASHLR_LLM_PROVIDER ?? "auto")
    .toLowerCase()
    .trim() as ProviderName;

  if (setting === "off") return noneProvider;

  if (setting === "anthropic") return anthropicProvider;
  if (setting === "cloud")     return cloudProvider;
  if (setting === "onnx")      return onnxProvider;
  if (setting === "local")     return localProvider;

  // "auto" — try each in order, return first available.
  // EXCEPTION: if the user explicitly set ASHLR_LLM_URL, respect that as a
  // strong "use local" signal and prefer local over Anthropic. Without that
  // env var, Anthropic-direct is preferred (best quality, cheaper for user).
  // Cloud fills the gap for Pro users who have a pro-token but no Anthropic key.
  if (process.env.ASHLR_LLM_URL) {
    if (await localProvider.isAvailable()) return localProvider;
  }
  if (await anthropicProvider.isAvailable()) return anthropicProvider;
  if (await cloudProvider.isAvailable())     return cloudProvider;
  if (await onnxProvider.isAvailable())      return onnxProvider;
  if (await localProvider.isAvailable())     return localProvider;

  return noneProvider;
}

// ---------------------------------------------------------------------------
// Cache (shared with _summarize.ts facade)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PROMPT_VERSION = 1;

// One-shot guard so `[ashlr] WARN: local LLM unreachable` only prints once
// per process, not on every summarize call when the misconfiguration persists.
let _localUnreachableWarned = false;

function home(): string { return process.env.HOME ?? homedir(); }
function cacheDir(): string { return join(home(), ".ashlr", "summary-cache"); }

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function readCache(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > CACHE_TTL_MS) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function writeCache(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Fallback truncation (preserved from original _summarize.ts)
// ---------------------------------------------------------------------------

function snipFallback(raw: string): string {
  if (raw.length <= 2000) return raw;
  return raw.slice(0, 800) + "\n\n[... " + (raw.length - 1600) + " bytes elided ...]\n\n" + raw.slice(-800);
}

function bypassHint(rawBytes: number, summaryBytes: number): string {
  const ratio = rawBytes > 0 ? (rawBytes / summaryBytes).toFixed(1) : "?";
  return `[ashlr summary · ${rawBytes.toLocaleString()} → ${summaryBytes.toLocaleString()} bytes · ${ratio}× reduction · pass bypassSummary:true to see full output]`;
}

// ---------------------------------------------------------------------------
// SummarizeOpts + SummarizeResult (mirrored from _summarize.ts public API)
// ---------------------------------------------------------------------------

export interface SummarizeOpts {
  toolName: string;
  systemPrompt: string;
  thresholdBytes?: number;
  bypass?: boolean;
  timeoutMs?: number;
  /** Legacy: override the LLM endpoint URL (OpenAI-compat). Passed through to
   *  local provider only for backward compatibility with existing tests. */
  endpointOverride?: string;
  /** Override the provider name (for testing). Bypasses env var. */
  providerOverride?: string;
}

export interface SummarizeResult {
  text: string;
  summarized: boolean;
  wasCached: boolean;
  fellBack: boolean;
  outputBytes: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_BYTES = 16_384;

/**
 * Summarize `rawText` if it exceeds the threshold. Falls back to snipCompact
 * when no LLM provider is available or when the provider throws.
 *
 * This is the implementation that `servers/_summarize.ts` re-exports, keeping
 * the public API stable for all callers.
 */
export async function summarizeIfLarge(
  rawText: string,
  opts: SummarizeOpts,
): Promise<SummarizeResult> {
  const threshold = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const rawBytes = Buffer.byteLength(rawText, "utf-8");

  if (rawBytes <= threshold) {
    await logEvent("tool_noop", { tool: opts.toolName, reason: "below-threshold" });
    return { text: rawText, summarized: false, wasCached: false, fellBack: false, outputBytes: rawBytes };
  }

  if (opts.bypass) {
    await logEvent("tool_noop", { tool: opts.toolName, reason: "bypassed" });
    return {
      text: rawText + "\n\n[ashlr · summarization bypassed (bypassSummary:true)]",
      summarized: false,
      wasCached: false,
      fellBack: false,
      outputBytes: rawBytes,
    };
  }

  // Cache check
  const cacheKey = sha256(opts.toolName + "::" + PROMPT_VERSION + "::" + rawText);
  const cachePath = join(cacheDir(), `${cacheKey}.txt`);
  const cached = await readCache(cachePath);
  if (cached) {
    await bumpStat("cacheHits");
    const out = cached + "\n" + bypassHint(rawBytes, Buffer.byteLength(cached, "utf-8"));
    return { text: out, summarized: true, wasCached: true, fellBack: false, outputBytes: Buffer.byteLength(out, "utf-8") };
  }

  await bumpStat("calls");

  // If endpointOverride is provided, use the legacy local-provider path directly
  // (preserves backward compat with existing tests that pass endpointOverride).
  if (opts.endpointOverride) {
    const summary = await callLegacyEndpoint(rawText, opts);
    if (summary == null) {
      await logEvent("tool_fallback", { tool: opts.toolName, reason: "llm-unreachable" });
      const fallback = snipFallback(rawText) + "\n\n[ashlr · LLM unreachable, fell back to truncation]";
      return { text: fallback, summarized: false, wasCached: false, fellBack: true, outputBytes: Buffer.byteLength(fallback, "utf-8") };
    }
    await writeCache(cachePath, summary).catch(() => undefined);
    const out = summary + "\n" + bypassHint(rawBytes, Buffer.byteLength(summary, "utf-8"));
    return { text: out, summarized: true, wasCached: false, fellBack: false, outputBytes: Buffer.byteLength(out, "utf-8") };
  }

  // New provider dispatch path
  const provider = await selectProvider(opts.providerOverride);
  const t0 = Date.now();
  let summary: string | null = null;
  let inTokens = 0;
  let outTokens = 0;
  let latencyMs = 0;
  let fellBackToSnipCompact = false;

  try {
    const result = await provider.summarize(rawText, opts.systemPrompt);
    summary = result.output;
    inTokens = result.inTokens;
    outTokens = result.outTokens;
    latencyMs = result.latencyMs;
  } catch {
    latencyMs = Date.now() - t0;
    fellBackToSnipCompact = true;
  }

  // Emit telemetry event
  const llmCostUsd = costForLLM(provider.name, inTokens, outTokens);
  await logEvent("tool_call", {
    tool: opts.toolName,
    extra: {
      event: "llm_summarize_provider_used",
      provider: provider.name,
      latency_ms: latencyMs,
      in_tokens: inTokens,
      out_tokens: outTokens,
      fellBackToSnipCompact,
      llmCostUsd,
    },
  });

  if (summary == null) {
    await logEvent("tool_fallback", { tool: opts.toolName, reason: "llm-unreachable" });
    // Per v1.22 review: when the SELECTED provider is local AND it failed,
    // surface a one-line stderr warning that names the URL the user
    // configured. Without this, a typo in ASHLR_LLM_URL silently degrades
    // every summarization to truncation with the only signal buried inside
    // tool output. Only logged once per process to avoid spam.
    if (provider.name === "local" && !_localUnreachableWarned) {
      _localUnreachableWarned = true;
      const url = process.env.ASHLR_LLM_URL ?? "http://localhost:1234/v1";
      process.stderr.write(
        `[ashlr] WARN: local LLM at ${url} unreachable; falling back to truncation. ` +
        `Verify the endpoint, or unset ASHLR_LLM_URL to let auto-selection prefer Anthropic.\n`,
      );
    }
    const fallback = snipFallback(rawText) + "\n\n[ashlr · LLM unreachable, fell back to truncation]";
    return { text: fallback, summarized: false, wasCached: false, fellBack: true, outputBytes: Buffer.byteLength(fallback, "utf-8") };
  }

  await writeCache(cachePath, summary).catch(() => undefined);
  const out = summary + "\n" + bypassHint(rawBytes, Buffer.byteLength(summary, "utf-8"));
  return { text: out, summarized: true, wasCached: false, fellBack: false, outputBytes: Buffer.byteLength(out, "utf-8") };
}

// ---------------------------------------------------------------------------
// Legacy endpoint path (backward compat for endpointOverride callers/tests)
// ---------------------------------------------------------------------------

async function callLegacyEndpoint(rawText: string, opts: SummarizeOpts): Promise<string | null> {
  const url = opts.endpointOverride!;
  const apiKey =
    process.env.ASHLR_LLM_KEY ??
    (process.env.ASHLR_PRO_TOKEN && !process.env.ASHLR_LLM_URL
      ? process.env.ASHLR_PRO_TOKEN
      : "local-llm");
  const model = process.env.ASHLR_LLM_MODEL ?? "qwen/qwen3-coder-30b@8bit";
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 800,
        temperature: 0.1,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: rawText },
        ],
      }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal stat bump helper
// ---------------------------------------------------------------------------

async function bumpStat(field: "calls" | "cacheHits"): Promise<void> {
  try { await bumpSummarization(field); } catch { /* best-effort */ }
}
