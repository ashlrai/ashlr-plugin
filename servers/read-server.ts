/**
 * read-server — ashlr__read tool implementation.
 *
 * Owns the snipCompact + summarization pipeline for file reads.
 * Uses _read-cache for per-session mtime-keyed caching.
 */

import { readFile } from "fs/promises";
import { statSync } from "fs";
import { compactReadContent, isCodeFile, numberCodeLines } from "./_efficiency-shared";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier, DEFAULT_THRESHOLD_BYTES } from "./_summarize";
import { tunedThreshold } from "./_tuner";
import { extname } from "path";
import { homedir } from "os";
import { logEvent } from "./_events";
import { recordSaving } from "./_stats";
import { clampToCwd, primaryProjectRoot } from "./_cwd-clamp";
import { getCached, setCached, type ReadCacheEntry } from "./_read-cache";
import { schedulePrefetch, type PrefetchTier } from "./_prefetch";
import { resolveLanguage } from "./_ast-languages";
import { renderAstSkeleton } from "./_ast-skeleton";
import { isProSync } from "./_pro";

/**
 * Minimum content byte-length before AST skeleton rendering is attempted.
 * Below this threshold the full snipCompact path is cheaper.
 */
export const AST_THRESHOLD = 6144;

export async function ashlrRead(input: { path: string; bypassSummary?: boolean; preserveLineNumbers?: boolean; mode?: "auto" | "ast" | "snip"; startLine?: unknown; endLine?: unknown }): Promise<string> {
  const clamp = clampToCwd(input.path, "ashlr__read");
  if (!clamp.ok) return clamp.message;
  const abs = clamp.abs;

  // Keep range reads separate from the whole-file cache and processing pipeline.
  if (input.startLine !== undefined || input.endLine !== undefined) {
    if (input.startLine === undefined) return "ashlr__read: endLine requires startLine";
    if (typeof input.startLine !== "number" || !Number.isFinite(input.startLine)) {
      return "ashlr__read: startLine must be a finite number";
    }
    if (input.endLine !== undefined && (typeof input.endLine !== "number" || !Number.isFinite(input.endLine))) {
      return "ashlr__read: endLine must be a finite number";
    }
    const start = Math.max(1, Math.floor(input.startLine));
    const end = input.endLine === undefined ? start + 199 : Math.floor(input.endLine as number);
    if (end < start) return "ashlr__read: reversed line range";
    const content = await readFile(abs, "utf-8");
    const lines = content.split("\n");
    if (start > lines.length) return "ashlr__read: startLine is outside the file";
    const cappedEnd = Math.min(lines.length, end);
    const pad = String(cappedEnd).length;
    const pathLabel = /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(input.path)
      ? JSON.stringify(input.path).replace(/[\x7f-\x9f\u2028-\u202e\u2066-\u2069]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      : input.path;
    return `${pathLabel} L${start}-L${cappedEnd} of ${lines.length}\n` +
      lines.slice(start - 1, cappedEnd).map((line, i) => `${String(start + i).padStart(pad, " ")}: ${line}`).join("\n");
  }

  // Cache hit path: same absolute path + unchanged mtime → return cached result.
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
    const hit = getCached(abs);
    if (hit && hit.mtimeMs === mtimeMs && input.bypassSummary !== true) {
      // On a repeat read we would otherwise have re-paid the full source bytes.
      // Credit the original-size saving again since the agent received zero new
      // tokens of file content.
      await recordSaving(hit.sourceBytes, 0, "ashlr__read");
      return `(cached)\n${hit.result}`;
    }
  } catch {
    // If stat fails (broken symlink, perms), fall through to the normal read
    // path which will surface a descriptive error.
  }

  const content = await readFile(abs, "utf-8");

  // ------------------------------------------------------------------
  // AST skeleton path: for large wired-language files in auto/ast mode,
  // return signatures-only skeleton instead of snipCompact head+tail.
  // Falls back to snipCompact on ANY failure (null return from skeleton).
  // ------------------------------------------------------------------
  const mode = input.mode ?? "auto";
  const wantAst =
    input.bypassSummary !== true &&
    mode !== "snip" &&
    (mode === "ast" ||
      (isCodeFile(abs) &&
        content.length > AST_THRESHOLD &&
        (() => {
          const lang = resolveLanguage(abs);
          return (
            lang === "typescript" || lang === "tsx" || lang === "javascript"
          );
        })()));

  if (wantAst) {
    const skel = await renderAstSkeleton(abs, content).catch(() => null);
    if (skel !== null && skel.length < content.length) {
      await recordSaving(content.length, skel.length, "ashlr__read");
      const skelBadgeOpts = {
        toolName: "ashlr__read",
        rawBytes: content.length,
        outputBytes: skel.length,
        fellBack: false,
        extra: `ast-skeleton${mtimeMs > 0 ? ` · mtime=${mtimeMs}` : ""}`,
      };
      const skelBadge = confidenceBadge(skelBadgeOpts);
      const skelNote =
        "\n// [ast-skeleton] Signatures only. Use bypassSummary:true to get the full file.";
      const skelResult = skel + skelNote + skelBadge;
      if (mtimeMs > 0) {
        setCached(abs, {
          mtimeMs,
          result: skelResult,
          sourceBytes: content.length,
        });
      }
      return skelResult;
    }
    // skeleton was null or not smaller → fall through to snipCompact
  }

  // For code files, prepend 1-based line numbers to every line before
  // snipCompact runs so `file:line` citations survive truncation.
  const preserveLineNumbers =
    input.preserveLineNumbers ?? isCodeFile(abs);
  const renderedContent = preserveLineNumbers
    ? numberCodeLines(content)
    : content;

  const out = compactReadContent(renderedContent);

  if (!(renderedContent.length > out.length)) {
    await logEvent("tool_noop", { tool: "ashlr__read", reason: "small-file" });
  }
  const summarizeInput = renderedContent.length > out.length ? renderedContent : out;
  // Self-tuning: per-repo detail level for ashlr__read on this extension (undefined = unchanged).
  const tunedBytes = tunedThreshold(
    "ashlr__read", extname(abs).toLowerCase(), DEFAULT_THRESHOLD_BYTES,
    process.env.ASHLR_HOME_OVERRIDE?.trim() || process.env.HOME || homedir(),
  );
  const summarized = await summarizeIfLarge(summarizeInput, {
    toolName: "ashlr__read",
    ...(tunedBytes === undefined ? {} : { thresholdBytes: tunedBytes }),
    systemPrompt: PROMPTS.read,
    bypass: input.bypassSummary === true,
  });
  const finalText = summarized.summarized || summarized.fellBack || input.bypassSummary ? summarized.text : out;
  const finalBytes = summarized.summarized || summarized.fellBack ? summarized.outputBytes : out.length;
  await recordSaving(content.length, finalBytes, "ashlr__read");

  const badgeOpts = {
    toolName: "ashlr__read",
    rawBytes: content.length,
    outputBytes: finalBytes,
    fellBack: summarized.fellBack,
    extra: mtimeMs > 0 ? `mtime=${mtimeMs}` : undefined,
  };
  if (confidenceTier(badgeOpts) === "low") {
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__read", reason: "low-confidence" });
  }
  const badge = confidenceBadge(badgeOpts);
  const finalTextWithBadge = finalText + badge;

  // Cache the fully computed result for this (path, mtimeMs). Skip caching
  // when bypassSummary was used — that's an opt-out path and shouldn't
  // poison future non-bypass calls.
  if (input.bypassSummary !== true && mtimeMs > 0) {
    setCached(abs, { mtimeMs, result: finalTextWithBadge, sourceBytes: content.length });
  }

  // Fire-and-forget predictive prefetch — Q3 supporting pillar. Scans X's
  // imports via lightweight regex and pre-caches the top-N neighbours so the
  // next ashlr__read on any of them is instant.
  //
  // MUST NOT be awaited. setImmediate inside schedulePrefetch defers the work
  // to the next tick, so the user's read response goes out first.
  try {
    const tier: PrefetchTier = isProSync() ? "pro" : "free";
    // Pro tier is the conservative default — team plans get bumped via cap.
    // schedulePrefetch clamps to per-tier cap regardless of what we pass.
    void schedulePrefetch(abs, {
      tier,
      maxNeighbors: 10,
      cwd: primaryProjectRoot(),
    });
  } catch {
    // Never let prefetch failures touch the read path.
  }

  return finalTextWithBadge;
}
