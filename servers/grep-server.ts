/**
 * grep-server — ashlr__grep tool implementation.
 *
 * Genome-aware retrieval when .ashlrcode/genome/ exists, ripgrep fallback
 * otherwise. Uses _embed-calibration for threshold constants and A/B logging.
 */

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  formatGenomeForPrompt,
  genomeExists,
} from "@ashlr/core-efficiency";
import { retrieveCached } from "./_genome-cache";
import { refreshGenomeAfterEdit } from "./_genome-live";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
import { findParentGenome } from "../scripts/genome-link";
import { getCalibrationMultiplier } from "../scripts/read-calibration";
import { recordSaving } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { getEmbeddingCache } from "./_tool-base";
import { embed, upsertCorpus } from "./_embedding-model";
import { populateGenomeEmbeddings } from "./_genome-embed-populator";
import { currentSessionId } from "./_stats";
import {
  EMBED_HIT_THRESHOLD,
  BM25_CORPUS_MIN,
  projectHash,
  readCorpusDocCount,
  recordEmbedCalibration,
} from "./_embed-calibration";

// ---------------------------------------------------------------------------
// Stale-detection counters (in-process, per session)
// ---------------------------------------------------------------------------

/** How many ripgrep fallbacks (with genome present) trigger the stale nudge. */
const STALE_NUDGE_THRESHOLD = 3;

let _staleFallbackCount = 0;
let _staleNudgeFired = false;

/** Reset for test isolation. */
export function _resetStaleFallbackCount(): void {
  _staleFallbackCount = 0;
  _staleNudgeFired = false;
}

/** Current stale fallback count (visible to tests). */
export function _getStaleFallbackCount(): number {
  return _staleFallbackCount;
}

/**
 * Resolve rg via Bun.which (walks PATH and common Homebrew locations). Shell
 * aliases like Claude Code's own rg wrapper don't resolve under spawn, so we
 * need the actual binary. Returns "rg" as last resort so spawn can at least
 * surface a useful error.
 */
function resolveRg(): string {
  return (
    (typeof (globalThis as { Bun?: { which(bin: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(bin: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg"
  );
}

/**
 * Estimate total matches by shelling out to `rg -c` (count-only, small
 * output). Returns null when rg is unavailable or the call fails — callers
 * should treat null as "unknown" rather than zero.
 */
function estimateMatchCount(pattern: string, cwd: string): number | null {
  try {
    const res = spawnSync(resolveRg(), ["-c", pattern, cwd], {
      encoding: "utf-8",
      timeout: 3_000,
    });
    if (res.status !== 0 && res.status !== 1) return null; // 1 == no matches
    const out = res.stdout ?? "";
    if (!out.trim()) return 0;
    let total = 0;
    for (const line of out.split("\n")) {
      const idx = line.lastIndexOf(":");
      if (idx < 0) continue;
      const n = parseInt(line.slice(idx + 1), 10);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  } catch {
    return null;
  }
}

export async function ashlrGrep(input: { pattern: string; cwd?: string; bypassSummary?: boolean }): Promise<string> {
  // Clamp input.cwd to process.cwd() — ripgrep spawns below use this path as
  // their search root, so an unclamped caller could exfiltrate /etc, /root, etc.
  const clamp = clampToCwd(input.cwd, "ashlr__grep");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;

  // Prefer the local genome. If none, walk up to 4 parents (capped at $HOME).
  let genomeRoot: string | null = null;
  let genomeIsParent = false;
  if (genomeExists(cwd)) {
    genomeRoot = cwd;
  } else {
    const parent = findParentGenome(cwd);
    if (parent) {
      genomeRoot = parent;
      genomeIsParent = true;
    }
  }

  if (!genomeRoot) {
    await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "no-genome" });
  }

  // ------------------------------------------------------------------
  // Embedding cache — query before genome retrieval (fire-and-forget
  // upsert on completion; never blocks if cache is disabled or slow).
  // ------------------------------------------------------------------
  const pHash = projectHash(cwd);
  const sessionId = currentSessionId();
  let embedCachePrefix = "";
  // v1.18 Trust Pass: the BM25 IDF corpus produces noisy similarity scores
  // below ~50 docs — gate the cache read on corpus size.
  const corpusSize = readCorpusDocCount();
  const embedCacheEnabled = corpusSize >= BM25_CORPUS_MIN;
  try {
    const ctxDb = getEmbeddingCache();

    if (genomeRoot) {
      try {
        await populateGenomeEmbeddings(genomeRoot, { ctxDb, projectHash: pHash });
      } catch {
        // Populator must never break grep.
      }
    }

    if (embedCacheEnabled) {
      const queryVec = await embed(input.pattern);
      const hits = ctxDb.searchSimilar({ projectHash: pHash, embedding: queryVec, limit: 3 });
      const topHit = hits[0];
      const topSim = topHit?.similarity ?? 0;
      const isHit = Boolean(topHit) && topSim >= EMBED_HIT_THRESHOLD;
      let hitContentLength = 0;
      if (isHit) {
        const hitSections = hits
          .filter((h) => h.similarity >= EMBED_HIT_THRESHOLD)
          .map((h) => `[embedding-cache hit | sim=${h.similarity.toFixed(3)} | ${h.sectionPath}]\n${h.sectionText}`)
          .join("\n\n");
        hitContentLength = hitSections.length;
        const tokensSaved = Math.round(hitContentLength / 4);
        embedCachePrefix = hitSections + "\n\n";
        ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: true, tokensSaved });
      } else {
        ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: false, tokensSaved: 0 });
      }
      const queryHashHex = createHash("sha256").update(input.pattern).digest("hex").slice(0, 12);
      void recordEmbedCalibration({
        queryHashHex,
        topSimilarity: topSim,
        hit: isHit,
        contentLength: hitContentLength,
        threshold: EMBED_HIT_THRESHOLD,
      });
    } else {
      ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: false, tokensSaved: 0 });
    }
  } catch {
    // Embedding cache errors must never break grep. Silently skip.
  }

  if (genomeRoot) {
    const sections = await retrieveCached(genomeRoot, input.pattern, 4000);
    if (sections.length === 0) {
      await logEvent("tool_fallback", { tool: "ashlr__grep", reason: "genome-empty" });
    }
    if (sections.length > 0) {
      const formatted = formatGenomeForPrompt(sections);
      const grepsMultiplier = getCalibrationMultiplier();
      let rawBytesEstimate = formatted.length * grepsMultiplier;

      if (process.env.ASHLR_CALIBRATE === "1") {
        try {
          const calibRes = spawnSync(resolveRg(), ["--json", "-n", input.pattern, cwd], {
            encoding: "buffer",
            timeout: 5_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          const calibBuf = calibRes.stdout as Buffer | null;
          const trueRawBytes = calibBuf ? calibBuf.length : 0;
          rawBytesEstimate = Math.max(trueRawBytes, formatted.length * grepsMultiplier);
        } catch {
          // Calibration run failed — silently fall through to the estimate.
        }
      }

      // v1.18 Trust Pass: neither side of recordSaving includes embedCachePrefix.
      await recordSaving(rawBytesEstimate, formatted.length, "ashlr__grep");
      const estimated = estimateMatchCount(input.pattern, cwd);
      if (estimated !== null && estimated > sections.length * 4) {
        await logEvent("tool_escalate", {
          tool: "ashlr__grep",
          reason: "incomplete-genome",
          extra: { sections: sections.length, estimated },
        });
      }
      const parentNote = genomeIsParent ? ` (from parent genome at ${genomeRoot})` : "";
      const countNote =
        estimated === null
          ? ""
          : ` · rg estimates ${estimated.toLocaleString()} total match${estimated === 1 ? "" : "es"}${
              estimated > sections.length * 4
                ? " · call with bypassSummary:true for the full ripgrep list"
                : ""
            }`;
      const header = `[ashlr__grep] genome-retrieved ${sections.length} section(s)${parentNote}${countNote}`;
      const genomeBadgeOpts = {
        toolName: "ashlr__grep",
        rawBytes: Math.round(rawBytesEstimate),
        outputBytes: formatted.length,
      };
      if (confidenceTier(genomeBadgeOpts) === "low") {
        await logEvent("tool_low_confidence_shipped", { tool: "ashlr__grep", reason: "low-confidence" });
      }
      return embedCachePrefix + `${header}\n\n${formatted}` + confidenceBadge(genomeBadgeOpts);
    }
  }

  // Genome was present but had no matching sections — this is a stale-genome
  // signal. Increment the in-session counter and emit a telemetry event.
  if (genomeRoot) {
    _staleFallbackCount++;
    await logEvent("genome_stale_detected", {
      tool: "ashlr__grep",
      reason: "genome-miss",
      extra: { pattern: input.pattern, sessionFallbackCount: _staleFallbackCount },
    });
  }

  const rgBin = resolveRg();

  const res = spawnSync(rgBin, ["--json", "-n", input.pattern, cwd], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  const raw = res.stdout ?? "";
  const truncated = raw.length > 4000 ? raw.slice(0, 2000) + "\n\n[... truncated ...]\n\n" + raw.slice(-1000) : raw;
  const summarized = await summarizeIfLarge(truncated, {
    toolName: "ashlr__grep",
    systemPrompt: PROMPTS.grep,
    bypass: input.bypassSummary === true,
  });
  await recordSaving(raw.length, summarized.outputBytes, "ashlr__grep");
  const rgBadgeOpts = {
    toolName: "ashlr__grep",
    rawBytes: raw.length,
    outputBytes: summarized.outputBytes,
    fellBack: summarized.fellBack,
  };
  if (confidenceTier(rgBadgeOpts) === "low") {
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__grep", reason: "low-confidence" });
  }

  // Post-grep: upsert matched snippets into the embedding cache (fire-and-forget).
  setImmediate(() => {
    try {
      const snippet = (summarized.text || raw).slice(0, 2000);
      if (snippet.length > 50) {
        upsertCorpus(snippet);
        const ctxDb = getEmbeddingCache();
        embed(snippet).then((vec) => {
          ctxDb.upsertEmbedding({
            projectHash: pHash,
            sectionPath: `grep:${input.pattern}`,
            sectionText: snippet,
            embedding: vec,
            embeddingDim: vec.length,
            source: "code",
          });
        }).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  });

  // Stale-genome nudge: after N fallbacks in the same session, surface a
  // hint so the user knows to refresh. Fire once per session.
  let staleNudge = "";
  if (genomeRoot && _staleFallbackCount >= STALE_NUDGE_THRESHOLD && !_staleNudgeFired) {
    _staleNudgeFired = true;
    staleNudge =
      `\n\n[ashlr] genome may be stale (${_staleFallbackCount} grep queries fell through to ripgrep). ` +
      `Run \`bun run scripts/genome-refresh-worker.ts\` to refresh, or ` +
      `\`bun run scripts/genome-refresh-worker.ts --full\` for a complete rebuild.`;
  }

  return embedCachePrefix + (summarized.text || "[no matches]") + confidenceBadge(rgBadgeOpts) + staleNudge;
}
