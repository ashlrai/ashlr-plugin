#!/usr/bin/env bun
/**
 * ashlr genome auto-consolidate — drains `.ashlrcode/genome/proposals.jsonl`
 * into the genome section files it targets, and truncates the queue when
 * done.
 *
 * Behavior:
 *   - Gate on ≥ 3 pending proposals. Fewer → no-op exit 0.
 *   - Group by section path, merge contents as bulleted append onto the
 *     existing section body (simple offline-deterministic fallback).
 *   - Log every run to `~/.ashlr/genome-consolidation.log`.
 *   - ASHLR_GENOME_AUTO=0 → silent exit 0.
 *
 * Usage:
 *   bun run scripts/genome-auto-consolidate.ts --dir <path>
 *
 * The `consolidateProposals` import exists in the import graph so the
 * plugin's dependency on core-efficiency stays explicit; we invoke the
 * deterministic fallback directly because core-efficiency's consolidator
 * reads a different queue (`evolution/pending.jsonl`, owned by the MCP
 * server). The fallback below is the "simple merge-as-bullets" path the
 * spec allows when no LLMSummarizer is available.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
// Imported for API-surface parity with the MCP server; the auto-consolidator
// uses the direct-fallback path so it stays offline and deterministic.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { consolidateProposals } from "@ashlr/core-efficiency/genome";
import { summarizeIfLarge as _summarizeIfLargeImpl, PROMPTS, type SummarizeResult, type SummarizeOpts } from "../servers/_summarize";

// Mutable hook container so tests can inject a stub via _hooks._summarizeIfLarge.
export const _hooks = {
  summarizeIfLarge: _summarizeIfLargeImpl as (rawText: string, opts: SummarizeOpts) => Promise<SummarizeResult>,
};

interface Proposal {
  id: string;
  agentId: string;
  section: string;
  operation: "append" | "update" | "create";
  content: string;
  rationale: string;
  timestamp: string;
  generation: number;
}

interface AshlrConfig {
  genomeAuto?: boolean;
}

const LOG_PATH = join(homedir(), ".ashlr", "genome-consolidation.log");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { dir?: string } {
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) dir = argv[++i];
  }
  return { dir };
}

// ---------------------------------------------------------------------------
// Auto-disable check
// ---------------------------------------------------------------------------

function isAutoEnabled(): boolean {
  if (process.env.ASHLR_GENOME_AUTO === "0") return false;
  const cfgPath = join(homedir(), ".ashlr", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as AshlrConfig;
      if (cfg.genomeAuto === false) return false;
    } catch {
      /* ignore */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Proposal queue IO
// ---------------------------------------------------------------------------

function readProposals(path: string): Proposal[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: Proposal[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t) as Proposal;
      if (j && typeof j.section === "string" && typeof j.content === "string") {
        out.push(j);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function sectionFilePath(genomeDir: string, section: string): string {
  return join(genomeDir, section);
}

function bulletize(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  // Keep bullets reasonable length; append-only.
  return `- ${flat}`;
}

/**
 * Jaccard similarity on the token sets of two strings. Used as a cheap
 * novelty gate so we don't re-append bullets that duplicate existing
 * section content. Stopwords-agnostic — relies on the length floor in
 * `tokenize` to skip grammatical filler.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_\-]+/)) {
    if (raw.length < 4) continue;
    tokens.add(raw);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Similarity threshold above which a proposed bullet is considered a
 * duplicate of an existing line. 0.6 is deliberately conservative — high
 * enough to catch near-identical auto-observations but low enough that
 * proposals genuinely rephrasing prior knowledge still land.
 */
const DUPLICATE_JACCARD_THRESHOLD = 0.6;

/**
 * Return existing section content split into non-empty trimmed lines —
 * used as the baseline for the duplicate-bullet check below.
 */
function readExistingLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Fallback: append bullets grouped by section to the section file.
 *
 * v1.13 adds a novelty gate — before appending, every proposal's content
 * is compared (Jaccard token-overlap) against existing lines in the
 * target section file. Proposals whose top similarity exceeds
 * {@link DUPLICATE_JACCARD_THRESHOLD} are dropped so the file stops
 * accumulating near-duplicate auto-observations over time.
 *
 * v1.15 (Phase 5.3): when ASHLR_GENOME_LLM_SYNTHESIS=1, raw proposal
 * content is routed through summarizeIfLarge with the genome_synthesize
 * prompt before Jaccard dedup. The LLM either returns 1-3 curated bullets
 * or a {novel:false} sentinel that drops the whole batch. Falls back to
 * the deterministic path on LLM error.
 */
export async function applyFallback(
  genomeDir: string,
  proposals: Proposal[],
): Promise<number> {
  const llmSynthesis = process.env["ASHLR_GENOME_LLM_SYNTHESIS"] === "1";

  const bySection = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const g = bySection.get(p.section) ?? [];
    g.push(p);
    bySection.set(p.section, g);
  }

  let applied = 0;
  const stamp = new Date().toISOString().slice(0, 10);

  for (const [section, items] of bySection) {
    const target = sectionFilePath(genomeDir, section);
    mkdirSync(dirname(target), { recursive: true });
    const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
    const existingLines = readExistingLines(target);
    const existingTokenSets = existingLines.map((line) => tokenize(line));

    let acceptedBullets: string[] = [];

    if (llmSynthesis) {
      // LLM synthesis path: batch all raw proposal content and send to LLM.
      const rawBatch = items.map((item) => item.content).join("\n");
      let llmBullets: string[] | null = null;
      try {
        const result = await _hooks.summarizeIfLarge(rawBatch, {
          systemPrompt: PROMPTS.genome_synthesize,
          toolName: "genome-consolidate",
          thresholdBytes: 200,
        });
        const llmText = result.text.trim();
        // Strip any trailing bypass hint line added by summarizeIfLarge.
        const lines = llmText.split("\n").filter((l) => l.trim().length > 0);
        const contentLines = lines.filter((l) => !l.startsWith("[ashlr "));
        // Check for novel:false sentinel — first non-whitespace line.
        const firstLine = contentLines[0]?.trim() ?? "";
        let parsed: unknown;
        try { parsed = JSON.parse(firstLine); } catch { parsed = null; }
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>)["novel"] === false
        ) {
          const reason = (parsed as Record<string, unknown>)["reason"] ?? "no reason given";
          logLine(
            `${new Date().toISOString()} section=${section} llm-synthesis=novel:false reason=${String(reason)}`,
          );
          continue; // drop entire batch for this section
        }
        // Extract bullet lines (lines starting with "- ").
        llmBullets = contentLines.filter((l) => l.startsWith("- "));
        if (llmBullets.length === 0 && contentLines.length > 0) {
          // LLM returned content but not in bullet form — wrap each line.
          llmBullets = contentLines.map((l) => `- ${l.replace(/^[-*]\s*/, "")}`);
        }
      } catch {
        // LLM error — fall through to deterministic path.
        llmBullets = null;
      }

      if (llmBullets !== null) {
        // Run Jaccard dedup on LLM-synthesized bullets against existing content.
        const acceptedBulletSets: Set<string>[] = [];
        for (const bullet of llmBullets) {
          const tokens = tokenize(bullet);
          const isDuplicate =
            existingTokenSets.some((et) => jaccard(tokens, et) >= DUPLICATE_JACCARD_THRESHOLD) ||
            acceptedBulletSets.some((at) => jaccard(tokens, at) >= DUPLICATE_JACCARD_THRESHOLD);
          if (isDuplicate) continue;
          acceptedBulletSets.push(tokens);
          acceptedBullets.push(bullet);
        }
      } else {
        // Graceful degradation: LLM errored, run deterministic bulletize path.
        const acceptedBulletSets: Set<string>[] = [];
        for (const item of items) {
          const bullet = bulletize(item.content);
          const tokens = tokenize(bullet);
          const isDuplicate =
            existingTokenSets.some((et) => jaccard(tokens, et) >= DUPLICATE_JACCARD_THRESHOLD) ||
            acceptedBulletSets.some((at) => jaccard(tokens, at) >= DUPLICATE_JACCARD_THRESHOLD);
          if (isDuplicate) continue;
          acceptedBulletSets.push(tokens);
          acceptedBullets.push(bullet);
        }
      }
    } else {
      // Deterministic path (default): Jaccard dedup on bulletized proposals.
      const acceptedBulletSets: Set<string>[] = [];
      for (const item of items) {
        const bullet = bulletize(item.content);
        const tokens = tokenize(bullet);
        const isDuplicate =
          existingTokenSets.some((et) => jaccard(tokens, et) >= DUPLICATE_JACCARD_THRESHOLD) ||
          acceptedBulletSets.some((at) => jaccard(tokens, at) >= DUPLICATE_JACCARD_THRESHOLD);
        if (isDuplicate) continue;
        acceptedBulletSets.push(tokens);
        acceptedBullets.push(bullet);
      }
    }

    if (acceptedBullets.length === 0) continue;

    const header = `\n\n## Auto-observations · ${stamp}\n`;
    const combined =
      (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
      header +
      acceptedBullets.join("\n") +
      "\n";
    writeFileSync(target, combined, "utf-8");
    applied += acceptedBullets.length;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logLine(msg: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, msg + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ConsolidateResult {
  ran: boolean;
  reason: string;
  before: number;
  after: number;
  applied: number;
}

export async function runConsolidate(dir: string): Promise<ConsolidateResult> {
  const cwd = resolve(dir);
  const genomeDir = join(cwd, ".ashlrcode", "genome");
  if (!existsSync(genomeDir)) {
    return { ran: false, reason: "no-genome", before: 0, after: 0, applied: 0 };
  }
  const proposalsPath = join(genomeDir, "proposals.jsonl");
  const before = readProposals(proposalsPath);
  if (before.length < 3) {
    return {
      ran: false,
      reason: "below-threshold",
      before: before.length,
      after: before.length,
      applied: 0,
    };
  }

  let applied = 0;
  try {
    applied = await applyFallback(genomeDir, before);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLine(
      `${new Date().toISOString()} cwd=${cwd} error=${msg} before=${before.length}`,
    );
    return {
      ran: false,
      reason: "apply-failed",
      before: before.length,
      after: before.length,
      applied: 0,
    };
  }

  // Truncate queue.
  try {
    writeFileSync(proposalsPath, "", "utf-8");
  } catch {
    /* ignore */
  }

  logLine(
    `${new Date().toISOString()} cwd=${cwd} before=${before.length} after=0 applied=${applied}`,
  );

  return {
    ran: true,
    reason: "ok",
    before: before.length,
    after: 0,
    applied,
  };
}

async function main(): Promise<void> {
  if (!isAutoEnabled()) {
    process.exit(0);
  }
  const { dir } = parseArgs(process.argv.slice(2));
  const target = dir ?? process.env.PROJECT_ROOT ?? process.cwd();
  try {
    const result = await runConsolidate(target);
    if (result.ran) {
      process.stdout.write(
        `ashlr-genome: consolidated ${result.applied} proposal${result.applied === 1 ? "" : "s"} into ${target}/.ashlrcode/genome/\n`,
      );
    }
  } catch {
    /* never block */
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
