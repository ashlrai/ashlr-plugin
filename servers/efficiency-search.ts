/** Genome-aware search, embedding retrieval, and ripgrep fallback. */
import { runWithTimeout } from "./_run-with-timeout";
import { formatGenomeForPrompt, genomeExists } from "@ashlr/core-efficiency";
import { retrieveCached } from "./_genome-cache";
import { getGenomeSearchIndex } from "./_genome-search";
import { summarizeIfLarge, PROMPTS, confidenceBadge, confidenceTier } from "./_summarize";
import { logEvent } from "./_events";
import { findParentGenome } from "../scripts/genome-link";
import { getCalibrationMultiplier } from "../scripts/read-calibration";
import { recordSaving, currentSessionId } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { rgStopReason, rgTextArgs, truncateRgText } from "./_rg-text";
import { getEmbeddingCache } from "./_tool-base";
import { embed, upsertCorpus } from "./_embedding-model";
import { populateGenomeEmbeddings } from "./_genome-embed-populator";
import { createHash } from "crypto";

/** Stable 8-char project hash from absolute cwd path. */
function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}

/**
 * Cosine similarity threshold for a cache hit to prepend results.
 *
 * Baseline 0.68 (down from 0.75 in v1.12) - calibrated against the 24-doc
 * BM25 corpus where IDF weights are nearly flat and real similarity scores
 * cluster lower than classic dense-embedding expectations. Override via
 * `ASHLR_EMBED_THRESHOLD` (float in [0, 1]). A/B data flows to
 * `~/.ashlr/embed-calibration.jsonl` (see recordEmbedCalibration below).
 */
const EMBED_HIT_THRESHOLD = (() => {
  const raw = process.env.ASHLR_EMBED_THRESHOLD;
  if (!raw) return 0.68;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.68;
})();

/**
 * Minimum BM25 corpus size before the embedding cache is consulted. Below
 * this threshold, IDF weights are dominated by noise and nearly any query
 * produces a spurious hit - see v1.17 incident where a 6-doc corpus emitted
 * 0.7+ cosine hits on unrelated patterns.
 *
 * v1.18 Trust Pass: if docCount < THIS, the cache is skipped outright.
 * Reads `~/.ashlr/embed-corpus.json` directly (the writer lives in
 * `_embedding-model.ts`) so we don't have to export a new function.
 */
const BM25_CORPUS_MIN = 50;

function readCorpusDocCount(): number {
  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs");
    const { join } = require("path") as typeof import("path");
    const { homedir } = require("os") as typeof import("os");
    const p = join(process.env.HOME ?? homedir(), ".ashlr", "embed-corpus.json");
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as { docCount?: number };
    return typeof parsed.docCount === "number" && Number.isFinite(parsed.docCount) ? parsed.docCount : 0;
  } catch {
    return 0;
  }
}

// Lightweight calibration log so we can tune EMBED_HIT_THRESHOLD from real data
// instead of guesses. Appends one JSONL record per grep call; fire-and-forget.
async function recordEmbedCalibration(record: {
  queryHashHex: string;
  topSimilarity: number;
  hit: boolean;
  contentLength: number;
  threshold: number;
}): Promise<void> {
  try {
    const { homedir } = await import("os");
    const { appendFile, mkdir } = await import("fs/promises");
    const { dirname, join } = await import("path");
    const path = join(process.env.HOME ?? homedir(), ".ashlr", "embed-calibration.jsonl");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await appendFile(path, line, "utf-8");
  } catch {
    // Calibration log is observability, not critical path.
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
 * output). Returns null when rg is unavailable or the call fails - callers
 * should treat null as "unknown" rather than zero.
 *
 * This is the *confidence signal* for genome-routed greps: it lets the
 * caller tell the model "genome returned N sections, rg sees ~M total
 * matches" so an incomplete summary doesn't pass silently. Cost is tiny
 * (single-integer-per-file output) and timeout is short.
 */
async function estimateMatchCount(pattern: string, cwd: string): Promise<number | null> {
  try {
    const res = await runWithTimeout({
      command: resolveRg(),
      args: ["-c", pattern, cwd],
      timeoutMs: 3_000,
    });
    if (res.exitCode !== 0 && res.exitCode !== 1) return null; // 1 == no matches
    const out = res.stdout ?? "";
    if (!out.trim()) return 0;
    // `rg -c` output is `path:count` per line.
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
  // Clamp input.cwd to process.cwd() - ripgrep spawns below use this path as
  // their search root, so an unclamped caller could exfiltrate /etc, /root,
  // etc. The parent-genome walk-up via findParentGenome() stays legitimate
  // because it only reads .ashlrcode/genome/ metadata in ancestor dirs, not
  // arbitrary files. Refuse outside paths at the top so downstream spawns
  // never see them.
  const clamp = clampToCwd(input.cwd, "ashlr__grep");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;

  // Prefer the local genome. If none, walk up to 4 parents (capped at $HOME)
  // looking for a workspace-level genome - e.g. a project under ~/Desktop/
  // can borrow ~/Desktop/.ashlrcode/genome/ when it has nothing of its own.
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
  // Embedding cache - query before genome retrieval (fire-and-forget
  // upsert on completion; never blocks if cache is disabled or slow).
  // ------------------------------------------------------------------
  const pHash = projectHash(cwd);
  const sessionId = currentSessionId();
  let embedCachePrefix = "";
  // v1.18 Trust Pass: the BM25 IDF corpus produces noisy similarity scores
  // below ~50 docs - we've observed spurious 0.7+ hits on unrelated
  // patterns. Gate the cache read on corpus size so we never serve a
  // false-positive prefix from a thin corpus.
  const corpusSize = readCorpusDocCount();
  const embedCacheEnabled = corpusSize >= BM25_CORPUS_MIN;
  try {
    const ctxDb = getEmbeddingCache();

    // Populate the cache on first-seen / mtime-bumped manifest so the
    // similarity query below has something to match against. Watermarked,
    // so steady-state grep calls pay only a tiny stat() + JSON read.
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
        void logEvent("embed_cache_hit", {
          tool: "ashlr__grep",
          extra: { topSimilarity: topSim, sectionsReturned: hits.filter((h) => h.similarity >= EMBED_HIT_THRESHOLD).length, tokensSaved },
        });
      } else {
        ctxDb.recordRetrieval({ sessionId, projectHash: pHash, pattern: input.pattern, hit: false, tokensSaved: 0 });
        void logEvent("embed_cache_miss", {
          tool: "ashlr__grep",
          extra: { topSimilarity: topSim, corpusSize },
        });
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
      // Skip-gated: record a miss with tokensSaved=0 so dashboards still
      // reflect lookup activity. No embedding call, no prefix - so the raw
      // baseline below is unaffected and no false-positive content lands
      // in the response.
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
      // Emit genome_route_taken telemetry (fire-and-forget)
      void logEvent("genome_route_taken", {
        tool: "ashlr__grep",
        extra: {
          sectionsRetrieved: sections.length,
          parentNote: genomeIsParent ? genomeRoot : null,
          hadConfidenceLow: false, // updated below if badge fires
        },
      });
      const formatted = formatGenomeForPrompt(sections);
      // Use empirical multiplier from ~/.ashlr/calibration.json when available;
      // falls back to 4× (hardcoded guess) when no calibration has been run.
      const grepsMultiplier = getCalibrationMultiplier();
      let rawBytesEstimate = formatted.length * grepsMultiplier;

      // ASHLR_CALIBRATE=1: run real rg --json in parallel to record the TRUE
      // raw bytes. Adds to normal work but never blocks the tool response.
      if (process.env.ASHLR_CALIBRATE === "1") {
        try {
          const calibRes = await runWithTimeout({
            command: resolveRg(),
            args: ["--json", "-n", input.pattern, cwd],
            timeoutMs: 5_000,
          });
          const trueRawBytes = Buffer.byteLength(calibRes.stdout, "utf-8");
          // Never underreport - take the max of empirical and estimated.
          rawBytesEstimate = Math.max(trueRawBytes, formatted.length * grepsMultiplier);
        } catch {
          // Calibration run failed - silently fall through to the estimate.
        }
      }

      // v1.18 Trust Pass invariant: neither side of recordSaving includes
      // `embedCachePrefix`. The cache prefix is response-only decoration;
      // counting its length as "raw bytes saved" would inflate savings on
      // every cache hit because we'd be crediting content we generated, not
      // content the agent would have otherwise fetched.
      await recordSaving(rawBytesEstimate, formatted.length, "ashlr__grep");
      // Run `rg -c` to get an independent estimate of total matches. If genome
      // returned only N sections but ripgrep would find 10× that, the model
      // needs to know it should escalate rather than trust a stale/partial
      // retrieval. This is the fix for the silent-incomplete-genome risk.
      const estimated = await estimateMatchCount(input.pattern, cwd);
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
        // v1.22 trust fix: previously emitted `tool_noop` even though the
        // compressed content WAS shipped to the caller. That mislabel
        // distorted savings accounting (10-25%) by treating shipped low-
        // confidence output as zero work. Use a dedicated event so the
        // negative signal (consider bypassSummary) is preserved without
        // claiming nothing was returned.
        await logEvent("tool_low_confidence_shipped", { tool: "ashlr__grep", reason: "low-confidence" });
      }
      return embedCachePrefix + `${header}\n\n${formatted}` + confidenceBadge(genomeBadgeOpts);
    }
  }

  // v1.27 Track 5: consult the genome-search inverted index before ripgrep.
  // The embedding-cache path above handles semantic-similarity hits; the
  // index handles token-exact matches that BM25/embeddings might miss when
  // the corpus is small or the query is acronym-heavy.
  if (genomeRoot) {
    try {
      const idx = getGenomeSearchIndex(genomeRoot);
      const indexHits = idx.lookup(input.pattern);
      if (indexHits.length >= 3) {
        const formatted = indexHits
          .slice(0, 12)
          .map((h) => `${h.file}:${h.line}: ${h.snippet}  // from genome: ${h.section}`)
          .join("\n");
        const moreNote = indexHits.length > 12 ? `\n[... and ${indexHits.length - 12} more genome hits \u2014 call with bypassSummary:true to see all]` : "";
        await logEvent("genome_search_hit", {
          tool: "ashlr__grep",
          extra: { results: indexHits.length, source: "index", grep_source: "genome" },
        });
        return embedCachePrefix + `[ashlr-grep | source=genome-search-index | hits=${indexHits.length} | ripgrep skipped]\n\n${formatted}${moreNote}`;
      } else if (indexHits.length === 0) {
        await logEvent("genome_search_miss", {
          tool: "ashlr__grep",
          extra: { grep_source: "ripgrep" },
        });
      }
      // 1-2 hits: continue to ripgrep - too few to confidently skip the full
      // search. Hybrid merge is a v1.28 follow-up.
    } catch {
      // Index failure must never break grep.
    }
  }

  const rgBin = resolveRg();

  const res = await runWithTimeout({
    command: rgBin,
    args: rgTextArgs(input.pattern, cwd),
    timeoutMs: 15_000,
  });
  // `raw` is what a plain grep would have returned, so savings are counted
  // against that, not against a verbose wire format.
  const raw = res.stdout ?? "";
  const truncated = truncateRgText(raw, rgStopReason(res));
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
    // v1.22 trust fix: see paired comment above on the genome path.
    await logEvent("tool_low_confidence_shipped", { tool: "ashlr__grep", reason: "low-confidence" });
  }

  // Post-grep: upsert matched snippets into the embedding cache (fire-and-forget).
  setImmediate(() => {
    try {
      const snippet = (summarized.text || raw).slice(0, 2000);
      if (snippet.length > 50) {
        upsertCorpus(snippet);
        const ctxDb = getEmbeddingCache();
        // embed() is async - spawn a detached micro-task so we never await here.
        // best-effort: embedding upsert is a speculative cache fill after the tool already returned; a failure here cannot affect the user's result.
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

  return embedCachePrefix + (summarized.text || "[no matches]") + confidenceBadge(rgBadgeOpts);
}

