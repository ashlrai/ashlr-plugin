/**
 * grep-server — ashlr__grep tool implementation.
 *
 * Genome-aware retrieval when .ashlrcode/genome/ exists, ripgrep fallback
 * otherwise. Uses _embed-calibration for threshold constants and A/B logging.
 */

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { readdirSync, statSync } from "fs";
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
  computeCorpusTier,
  computeWarmThreshold,
  type CorpusTier,
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

// ---------------------------------------------------------------------------
// Warm-start background indexing (v1.24 Track E)
// ---------------------------------------------------------------------------

/**
 * Source-file extensions eligible for warm-start background indexing.
 * We stay away from generated / binary / lock files.
 */
const WARM_INDEX_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".md", ".mdx", ".txt", ".json",
]);

/**
 * Return up to `limit` source files from `dir` using a fast shallow scan
 * (no recursive walk — we only need a small sample, not full coverage).
 * Randomised via Fisher-Yates so repeated warm calls spread coverage.
 */
export function _sampleSourceFiles(dir: string, limit = 2): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = e.name.slice(dot).toLowerCase();
      if (!WARM_INDEX_EXTENSIONS.has(ext)) continue;
      files.push(`${dir}/${e.name}`);
    }
    // Fisher-Yates shuffle (in-place), then take first `limit`.
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = files[i]!;
      files[i] = files[j]!;
      files[j] = tmp;
    }
    return files.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fire-and-forget: read 1-2 random source files from `cwd`, chunk them via
 * upsertCorpus + embed, and upsert into the context DB. This grows the warm
 * corpus without blocking the grep response.
 *
 * Exported for test injection — production callers use setImmediate wrapper.
 */
export async function _warmIndexFiles(
  cwd: string,
  pHash: string,
  ctxDb: import("./_embedding-cache").ContextDb,
): Promise<void> {
  const { readFileSync } = await import("fs");
  const files = _sampleSourceFiles(cwd, 2);
  for (const filePath of files) {
    try {
      let size = 0;
      try { size = statSync(filePath).size; } catch { continue; }
      if (size === 0 || size > 200_000) continue; // skip empty / huge files
      const text = readFileSync(filePath, "utf-8").slice(0, 4000);
      if (text.length < 20) continue;
      upsertCorpus(text);
      const vec = await embed(text);
      ctxDb.upsertEmbedding({
        projectHash: pHash,
        sectionPath: `warm:${filePath}`,
        sectionText: text.slice(0, 2000),
        embedding: vec,
        embeddingDim: vec.length,
        source: "code",
      });
      void logEvent("embed_warm_index", {
        tool: "ashlr__grep",
        extra: { filePath, textLen: text.length },
      });
    } catch {
      /* best-effort — never block grep */
    }
  }
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
  // Embedding cache — three-tier warm-start (v1.24 Track E).
  //
  // cold (0–9 docs)  : skip cache entirely; corpus too small for reliable IDF.
  // warm (10–49 docs): consult cache with a stricter per-size gradient threshold
  //                    (0.80 at N=10, linearly easing to 0.68 at N=50).
  //                    After the response, enqueue 1-2 random files for background
  //                    chunking + embedding to grow the corpus (fire-and-forget).
  // hot  (50+ docs)  : full v1.23 behavior, threshold = EMBED_HIT_THRESHOLD (0.68).
  //
  // The `tier` field is emitted on every embed_cache_hit/miss event so Track A
  // (adaptive thresholds) can later observe whether the gradient is the right curve.
  // ------------------------------------------------------------------
  const pHash = projectHash(cwd);
  const sessionId = currentSessionId();
  let embedCachePrefix = "";
  const corpusSize = readCorpusDocCount();
  const corpusTier: CorpusTier = computeCorpusTier(corpusSize);
  // Effective threshold for this call — only meaningful for warm/hot.
  const effectiveThreshold = corpusTier === "hot" ? EMBED_HIT_THRESHOLD : computeWarmThreshold(corpusSize);
  const embedCacheEnabled = corpusTier !== "cold";
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
      const isHit = Boolean(topHit) && topSim >= effectiveThreshold;
      let hitContentLength = 0;
      if (isHit) {
        const hitSections = hits
          .filter((h) => h.similarity >= effectiveThreshold)
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
        threshold: effectiveThreshold,
      });
      void logEvent(isHit ? "embed_cache_hit" : "embed_cache_miss", {
        tool: "ashlr__grep",
        extra: { topSimilarity: topSim, corpusSize, tier: corpusTier, threshold: effectiveThreshold },
      });

      // Warm tier: fire-and-forget background indexing of 1-2 random files
      // to grow the corpus without blocking the grep response.
      if (corpusTier === "warm") {
        setImmediate(() => {
          try {
            _warmIndexFiles(cwd, pHash, getEmbeddingCache()).catch(() => {});
          } catch {
            /* best-effort */
          }
        });
      }
    } else {
      // cold — record the miss for accounting but don't touch the cache.
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
