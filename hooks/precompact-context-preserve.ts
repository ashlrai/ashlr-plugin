#!/usr/bin/env bun
/**
 * precompact-context-preserve.ts — PreCompact hook.
 *
 * Emits a ≤600-byte "survival kit" as additionalContext so the model can
 * re-orient itself after context compaction:
 *   1. Genome section names from the nearest .ashlrcode/genome/manifest.json
 *      (max 20 names, comma-separated — no bodies).
 *   2. Session-state line: tokens saved this session + top tool by calls.
 *   3. Directive: re-orient via ashlr__orient or /ashlr-resume after compaction.
 *
 * Env toggles:
 *   ASHLR_GENOME_AUTO=0 — suppress the genome section-names line.
 *
 * Contract: never throws — falls back to a minimal fallback message.
 * Always exits 0. Outputs to stdout only.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

import { noteHookError } from "./_hook-errors";

interface PreCompactHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreCompact";
    additionalContext?: string;
  };
}

interface ManifestSection {
  name?: string;
  title?: string;
  [key: string]: unknown;
}

interface ManifestFile {
  sections?: ManifestSection[];
  [key: string]: unknown;
}

/** Walk up from `start` looking for .ashlrcode/genome/manifest.json. */
function findManifest(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 12; i++) {
    const candidate = join(cur, ".ashlrcode", "genome", "manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** Extract up to `max` section names from manifest.json. */
export function extractSectionNames(manifestPath: string, max = 20): string[] {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as ManifestFile;
    const sections = manifest.sections ?? [];
    const names: string[] = [];
    for (const s of sections) {
      const n = s.name ?? s.title ?? "";
      if (n && typeof n === "string") names.push(n.trim());
      if (names.length >= max) break;
    }
    return names;
  } catch (e) {
    noteHookError("precompact-context-preserve", "extractSectionNames", e);
    return [];
  }
}

export interface SessionSummary {
  tokensSaved: number;
  calls: number;
  topTool: string | null;
}

/** Build the session-state line from raw stats values. */
export function buildSessionLine(summary: SessionSummary): string {
  const { tokensSaved, calls, topTool } = summary;
  const topPart = topTool ? `; top: ${topTool}` : "";
  return `session: ${tokensSaved.toLocaleString()} tokens saved across ${calls} calls${topPart}`;
}

/** Build the full survival-kit context string, capped at `cap` bytes. */
export function buildSurvivalKit(opts: {
  sectionNames: string[];
  sessionSummary: SessionSummary;
  cap?: number;
  includeGenome?: boolean;
}): string {
  const cap = opts.cap ?? 600;
  const { sectionNames, sessionSummary, includeGenome = true } = opts;

  const lines: string[] = [];

  if (includeGenome && sectionNames.length > 0) {
    lines.push(`genome sections: ${sectionNames.join(", ")}`);
  }

  lines.push(buildSessionLine(sessionSummary));
  lines.push("re-orient: run ashlr__orient or /ashlr-resume before continuing work after compaction");

  const full = lines.join("\n");
  // Hard cap: truncate at cap bytes preserving UTF-8 boundaries.
  if (Buffer.byteLength(full, "utf-8") <= cap) return full;
  // Trim genome names until it fits.
  if (includeGenome && sectionNames.length > 0) {
    for (let n = sectionNames.length - 1; n >= 0; n--) {
      const trimmed = [
        n > 0 ? `genome sections: ${sectionNames.slice(0, n).join(", ")}` : null,
        buildSessionLine(sessionSummary),
        "re-orient: run ashlr__orient or /ashlr-resume before continuing work after compaction",
      ]
        .filter(Boolean)
        .join("\n");
      if (Buffer.byteLength(trimmed, "utf-8") <= cap) return trimmed;
    }
  }
  // Fallback: just session + directive.
  const minimal = [
    buildSessionLine(sessionSummary),
    "re-orient: run ashlr__orient or /ashlr-resume before continuing work after compaction",
  ].join("\n");
  return minimal.slice(0, cap);
}

async function main(): Promise<void> {
  try {
    // Drain stdin (PreCompact payload may be piped in but we don't need it).
    try {
      if (!process.stdin.isTTY) {
        await Promise.race([
          (async () => {
            for await (const _ of process.stdin as AsyncIterable<unknown>) { /* discard */ }
          })(),
          new Promise((r) => setTimeout(r, 50)),
        ]);
      }
    } catch { /* ignore */ }

    const includeGenome = process.env.ASHLR_GENOME_AUTO !== "0";

    // 1. Genome section names.
    let sectionNames: string[] = [];
    if (includeGenome) {
      const manifestPath = findManifest(process.cwd());
      if (manifestPath) {
        sectionNames = extractSectionNames(manifestPath, 20);
      }
    }

    // 2. Session stats via _stats.ts.
    let sessionSummary: SessionSummary = { tokensSaved: 0, calls: 0, topTool: null };
    try {
      // Dynamic import so a missing module never crashes the hook.
      const statsPath = join(
        process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(import.meta.url.replace("file://", "")), ".."),
        "servers",
        "_stats",
      );
      const { readCurrentSession } = await import(statsPath) as {
        readCurrentSession: () => Promise<{ tokensSaved: number; calls: number; byTool: Record<string, { calls: number }> }>;
      };
      const sess = await readCurrentSession();
      // Find top tool by calls.
      let topTool: string | null = null;
      let topCalls = 0;
      for (const [tool, pt] of Object.entries(sess.byTool ?? {})) {
        if (pt.calls > topCalls) { topCalls = pt.calls; topTool = tool; }
      }
      sessionSummary = { tokensSaved: sess.tokensSaved, calls: sess.calls, topTool };
    } catch {
      /* best-effort — stats unavailable */
    }

    const context = buildSurvivalKit({ sectionNames, sessionSummary, includeGenome });

    const out: PreCompactHookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        ...(context ? { additionalContext: context } : {}),
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    noteHookError("precompact-context-preserve", "main", e);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreCompact",
          additionalContext: "[ashlr: context compacted — re-orient before continuing]",
        },
      }),
    );
  }
}

if (import.meta.main) {
  void main();
}
