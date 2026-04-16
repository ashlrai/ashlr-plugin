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

/** Simple fallback: append bullets grouped by section to the section file. */
export function applyFallback(
  genomeDir: string,
  proposals: Proposal[],
): number {
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
    const header = `\n\n## Auto-observations · ${stamp}\n`;
    const bullets = items.map((i) => bulletize(i.content)).join("\n");
    const combined =
      (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
      header +
      bullets +
      "\n";
    writeFileSync(target, combined, "utf-8");
    applied += items.length;
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

export function runConsolidate(dir: string): ConsolidateResult {
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
    applied = applyFallback(genomeDir, before);
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
    const result = runConsolidate(target);
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
