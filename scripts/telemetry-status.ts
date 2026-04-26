#!/usr/bin/env bun
/**
 * telemetry-status.ts — Telemetry snapshot for /ashlr-status --telemetry.
 *
 * Reports:
 *   - LLM provider that would be selected right now
 *   - Embedding cache: total entries + last-100 hit rate
 *   - Genome: sections present + last-50 grep fire-rate
 *   - Block→ashlr conversion ratio (24h rolling)
 *
 * Contract: always exit 0. No external dependencies beyond the ashlr data
 * files already present on disk. Falls back to "—" for any missing data.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isTelemetryEnabled, readTelemetryBuffer } from "../servers/_telemetry";

const HOME = process.env.HOME ?? homedir();
const ASHLR_DIR = join(HOME, ".ashlr");

// ---------------------------------------------------------------------------
// LLM provider detection
// ---------------------------------------------------------------------------

function detectLlmProvider(): string {
  // Anthropic: ANTHROPIC_API_KEY set in env, or ~/.claude/credentials.json
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic (ANTHROPIC_API_KEY set)";
  }
  try {
    const credPath = join(HOME, ".claude", "credentials.json");
    if (existsSync(credPath)) {
      const creds = JSON.parse(readFileSync(credPath, "utf-8")) as Record<string, unknown>;
      if (creds.anthropicApiKey || creds.ANTHROPIC_API_KEY) {
        return "anthropic (credentials.json)";
      }
    }
  } catch {
    // ignore
  }

  // ONNX: check for onnxruntime-node availability
  try {
    require.resolve("onnxruntime-node");
    return "onnx (bundled runtime)";
  } catch {
    // not available
  }

  // Local: check for Ollama or LM Studio
  const ollamaUrl = process.env.ASHLR_EMBED_URL ?? "http://localhost:11434";
  if (ollamaUrl.includes("11434")) {
    return "local/ollama (if running) → snipCompact fallback";
  }

  return "snipCompact-only (no LLM provider configured)";
}

// ---------------------------------------------------------------------------
// Embedding cache stats
// ---------------------------------------------------------------------------

function readEmbedCacheStats(): { totalEntries: number; last100HitRate: string } {
  let totalEntries = 0;
  let last100HitRate = "—";

  // Total entries from embed-calibration.jsonl (each line = one lookup)
  try {
    const calPath = join(ASHLR_DIR, "embed-calibration.jsonl");
    if (existsSync(calPath)) {
      const lines = readFileSync(calPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      totalEntries = lines.length;

      // Last 100 calls hit rate
      const last100 = lines.slice(-100);
      if (last100.length > 0) {
        let hits = 0;
        for (const line of last100) {
          try {
            const r = JSON.parse(line) as { hit?: boolean };
            if (r.hit === true) hits++;
          } catch {
            // skip
          }
        }
        const rate = Math.round((hits / last100.length) * 100);
        last100HitRate = `${rate}%`;
      }
    }
  } catch {
    // ignore
  }

  return { totalEntries, last100HitRate };
}

// ---------------------------------------------------------------------------
// Genome stats
// ---------------------------------------------------------------------------

function readGenomeStats(): { sections: string; fireRate: string } {
  // Count sections in .ashlrcode/genome/ relative to cwd
  let sections = "—";
  const genomePath = join(process.cwd(), ".ashlrcode", "genome");
  if (existsSync(genomePath)) {
    try {
      // Count .md files in the genome directory
      const files = readdirSync(genomePath, { withFileTypes: true });
      const mdCount = files.filter((f) => f.isFile() && f.name.endsWith(".md")).length;
      sections = `${mdCount}`;
    } catch {
      sections = "present (count unavailable)";
    }
  } else {
    sections = "0 (no genome — run /ashlr-genome-init)";
  }

  // Fire rate from last 50 ashlr__grep calls in session-log.jsonl
  let fireRate = "—";
  try {
    const logPath = join(ASHLR_DIR, "session-log.jsonl");
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim());

      // Find last 50 ashlr__grep tool_call events + genome_route_taken events
      const grepRelated = lines
        .map((l) => {
          try { return JSON.parse(l) as { event?: string; tool?: string }; }
          catch { return null; }
        })
        .filter((r): r is { event: string; tool?: string } =>
          r !== null && typeof r.event === "string" &&
          (r.tool === "ashlr__grep" || r.event === "genome_route_taken")
        )
        .slice(-100); // look at recent history

      // Count total grep calls and genome-routed ones in last 50 grep-related events
      const last50 = grepRelated.slice(-50);
      const totalGreps = last50.filter((r) => r.tool === "ashlr__grep").length;
      const genomeRouted = last50.filter((r) => r.event === "genome_route_taken").length;

      if (totalGreps > 0) {
        const rate = Math.round((genomeRouted / totalGreps) * 100);
        fireRate = `${rate}%`;
      } else if (grepRelated.length > 0) {
        fireRate = "0% (no recent grep calls)";
      }
    }
  } catch {
    // ignore
  }

  return { sections, fireRate };
}

// ---------------------------------------------------------------------------
// Block→ashlr conversion ratio (24h)
// ---------------------------------------------------------------------------

function readConversionRatio(): string {
  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  let blocks = 0;
  let converted = 0;

  // Blocks from hook-timings.jsonl (outcome === "block")
  try {
    const timingsPath = join(ASHLR_DIR, "hook-timings.jsonl");
    if (existsSync(timingsPath)) {
      const lines = readFileSync(timingsPath, "utf-8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as { ts?: string; outcome?: string };
          const ts = typeof r.ts === "string" ? Date.parse(r.ts) : 0;
          if (Number.isFinite(ts) && ts >= cutoff && r.outcome === "block") {
            blocks++;
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // ignore
  }

  // Conversions from session-log.jsonl (event === "tool_called_after_block")
  try {
    const logPath = join(ASHLR_DIR, "session-log.jsonl");
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as { ts?: string; event?: string };
          const ts = typeof r.ts === "string" ? Date.parse(r.ts) : 0;
          if (Number.isFinite(ts) && ts >= cutoff && r.event === "tool_called_after_block") {
            converted++;
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // ignore
  }

  if (blocks === 0 && converted === 0) return "— (no data yet)";
  const rate = blocks > 0 ? Math.round((converted / blocks) * 100) : 0;
  return `${blocks} blocks / ${converted} converted = ${rate}% (24h)`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Opt-in telemetry status
// ---------------------------------------------------------------------------

function readOptInTelemetryStatus(): string {
  const enabled = isTelemetryEnabled(HOME);
  if (!enabled) {
    return "OFF (default) · to enable: ASHLR_TELEMETRY=on or config.json { \"telemetry\": \"opt-in\" }";
  }
  // Count buffered events.
  let bufferCount = 0;
  try {
    const records = readTelemetryBuffer(HOME);
    bufferCount = records.length;
  } catch {
    /* ignore */
  }
  return `ON · buffer: ${bufferCount} events · to disable: ASHLR_TELEMETRY=off`;
}

async function main(): Promise<void> {
  const provider = detectLlmProvider();
  const { totalEntries, last100HitRate } = readEmbedCacheStats();
  const { sections, fireRate } = readGenomeStats();
  const conversionRatio = readConversionRatio();
  const optInStatus = readOptInTelemetryStatus();

  const embedStr = totalEntries > 0
    ? `${totalEntries.toLocaleString()} entries · last-100 hit rate ${last100HitRate}`
    : `0 entries · ${last100HitRate}`;

  const genomeStr = `${sections} sections · last-50 grep fire-rate ${fireRate}`;

  process.stdout.write([
    "## Telemetry snapshot",
    `  llm-provider:   ${provider}`,
    `  embed-cache:    ${embedStr}`,
    `  genome:         ${genomeStr}`,
    `  block→ashlr:    ${conversionRatio}`,
    `  opt-in telemetry: ${optInStatus}`,
    "",
  ].join("\n"));
}

await main();
process.exit(0);
