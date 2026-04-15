#!/usr/bin/env bun
/**
 * ashlr genome-init — initialize a `.ashlrcode/genome/` directory in a project.
 *
 * Reuses @ashlr/core-efficiency's `initGenome` for the base scaffold, then
 * layers on ashlr-plugin-specific customizations:
 *   - ADR-0000 placeholder in knowledge/decisions.md
 *   - Auto-populated knowledge/architecture.md from the baseline scanner
 *   - Auto-populated knowledge/conventions.md from detected config files
 *
 * Usage:
 *   bun run scripts/genome-init.ts --dir <path> [--force] [--minimal]
 */

import { existsSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { basename, join, resolve } from "path";
import { initGenome } from "@ashlr/core-efficiency/genome";
import {
  genomeDir,
  genomeExists,
  loadManifest,
  writeSection,
} from "@ashlr/core-efficiency/genome";
import { scan, type Baseline } from "./baseline-scan.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface CliArgs {
  dir?: string;
  force: boolean;
  minimal: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let dir: string | undefined;
  let force = false;
  let minimal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (a === "--force") force = true;
    else if (a === "--minimal") minimal = true;
  }
  return { dir, force, minimal };
}

// ---------------------------------------------------------------------------
// Convention detection
// ---------------------------------------------------------------------------

export interface DetectedConventions {
  detected: string[]; // human-readable bullet lines
  files: string[]; // filenames found
}

export function detectConventions(dir: string): DetectedConventions {
  const files: string[] = [];
  const detected: string[] = [];

  // biome.json
  if (existsSync(join(dir, "biome.json")) || existsSync(join(dir, "biome.jsonc"))) {
    files.push("biome.json");
    detected.push("Biome is configured — lint + format via `biome check`.");
  }

  // eslint
  const eslintCandidates = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
  ];
  for (const name of eslintCandidates) {
    if (existsSync(join(dir, name))) {
      files.push(name);
      detected.push(`ESLint is configured (${name}).`);
      break;
    }
  }

  // prettier
  const prettierCandidates = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
  ];
  for (const name of prettierCandidates) {
    if (existsSync(join(dir, name))) {
      files.push(name);
      detected.push(`Prettier is configured (${name}).`);
      break;
    }
  }

  // editorconfig
  if (existsSync(join(dir, ".editorconfig"))) {
    files.push(".editorconfig");
    detected.push(".editorconfig present — respect indent/newline conventions.");
  }

  // tsconfig strict settings
  const tsconfigPath = join(dir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    files.push("tsconfig.json");
    try {
      const raw = readFileSync(tsconfigPath, "utf-8");
      // Strip comments for JSONC safety
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const ts = JSON.parse(cleaned);
      const co = (ts && typeof ts === "object" && ts.compilerOptions) || {};
      const strictFlags: string[] = [];
      for (const key of [
        "strict",
        "noImplicitAny",
        "strictNullChecks",
        "noUncheckedIndexedAccess",
        "noImplicitReturns",
        "noFallthroughCasesInSwitch",
      ]) {
        if (co[key] === true) strictFlags.push(key);
      }
      if (strictFlags.length > 0) {
        detected.push(
          `TypeScript strict settings enabled: ${strictFlags.join(", ")}.`,
        );
      } else {
        detected.push("TypeScript is used (tsconfig.json present).");
      }
    } catch {
      detected.push("TypeScript is used (tsconfig.json present, but unparseable).");
    }
  }

  // package.json scripts
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    files.push("package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = (pkg && pkg.scripts) || {};
      const names = Object.keys(scripts);
      if (names.length > 0) {
        const notable = names
          .filter((n) =>
            ["test", "lint", "typecheck", "build", "format", "check"].includes(n),
          )
          .slice(0, 8);
        if (notable.length > 0) {
          detected.push(
            `package.json scripts: ${notable.map((n) => `\`${n}\``).join(", ")}.`,
          );
        } else {
          detected.push(
            `package.json scripts present: ${names.slice(0, 6).map((n) => `\`${n}\``).join(", ")}.`,
          );
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (detected.length === 0) {
    detected.push("No standard lint/format configs detected.");
  }

  return { detected, files };
}

// ---------------------------------------------------------------------------
// Architecture from baseline scan
// ---------------------------------------------------------------------------

export function renderArchitectureMd(b: Baseline): string {
  const lines: string[] = [];
  lines.push("# Architecture");
  lines.push("");
  lines.push(
    "> Auto-populated from an ashlr baseline scan at genome init. Edit freely to",
    "> capture intent and tradeoffs that a scanner cannot see.",
  );
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push(`- **Files scanned:** ${b.fileCount}${b.truncated ? " (truncated)" : ""}`);
  lines.push(`- **Runtime:** ${b.runtime.name}`);
  if (b.runtime.notes.length > 0) {
    lines.push(`- **Runtime notes:** ${b.runtime.notes.join("; ")}`);
  }
  if (b.topExtensions.length > 0) {
    lines.push(
      `- **Top extensions:** ${b.topExtensions.map((e) => `${e.ext} (${e.count})`).join(", ")}`,
    );
  }
  if (b.entryPoints.length > 0) {
    lines.push(`- **Entry points:** ${b.entryPoints.slice(0, 5).join(", ")}`);
  }
  if (b.tests.count > 0) {
    lines.push(
      `- **Tests:** ${b.tests.count} files${b.tests.framework ? ` via ${b.tests.framework}` : ""}`,
    );
  }
  if (b.largestFiles.length > 0) {
    lines.push("");
    lines.push("## Largest source files");
    lines.push("");
    for (const f of b.largestFiles) {
      lines.push(`- \`${f.path}\` — ${f.loc} LOC`);
    }
  }
  lines.push("");
  lines.push("## Top-level layout");
  lines.push("");
  lines.push("```");
  lines.push(renderTopLevelTree(b));
  lines.push("```");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Replace this section with an intent-level description: why does each top-level dir exist, what does it own, and what crosses its boundary?");
  lines.push("");
  return lines.join("\n");
}

function renderTopLevelTree(b: Baseline): string {
  // We don't have the full file list in Baseline, but entryPoints + largest
  // give a decent skeleton. Supplement with readdir of top level.
  const topDirs = new Set<string>();
  const rootFiles: string[] = [];
  try {
    const entries = readFileSync; // no-op to keep ts happy
    void entries;
  } catch {
    /* ignore */
  }
  // Use directly: readdir sync
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require("fs") as typeof import("fs");
    for (const e of readdirSync(b.dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") && e.name !== ".ashlrcode") continue;
      if (["node_modules", "dist", "build", "coverage"].includes(e.name)) continue;
      if (e.isDirectory()) topDirs.add(e.name + "/");
      else rootFiles.push(e.name);
    }
  } catch {
    /* ignore */
  }
  const lines: string[] = [`${basename(b.dir)}/`];
  const dirs = [...topDirs].sort();
  const files = rootFiles.sort();
  for (const d of dirs) lines.push(`├── ${d}`);
  for (const f of files) lines.push(`├── ${f}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Conventions markdown
// ---------------------------------------------------------------------------

export function renderConventionsMd(det: DetectedConventions): string {
  const lines: string[] = [];
  lines.push("# Conventions");
  lines.push("");
  lines.push(
    "> Auto-populated from detected config files at genome init. Replace with",
    "> the conventions your team actually enforces in review.",
  );
  lines.push("");
  lines.push("## Detected");
  lines.push("");
  for (const d of det.detected) lines.push(`- ${d}`);
  if (det.files.length > 0) {
    lines.push("");
    lines.push("## Source files");
    lines.push("");
    for (const f of det.files) lines.push(`- \`${f}\``);
  }
  lines.push("");
  lines.push("## Team conventions");
  lines.push("");
  lines.push("- _Add conventions that aren't captured in config: naming, file layout, commit style, PR protocol._");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ADR stub
// ---------------------------------------------------------------------------

export function renderDecisionsMd(): string {
  return [
    "# Architectural Decision Records",
    "",
    "> Each non-obvious decision gets an ADR entry. Append — do not rewrite history.",
    "",
    "---",
    "",
    "## ADR-0000: Initialize genome",
    "",
    "- **Status:** Accepted",
    "- **Date:** " + new Date().toISOString().slice(0, 10),
    "- **Context:** This project now uses an ashlr genome so the agent can route",
    "  grep/recall through retrieval instead of re-reading files (~-84% token",
    "  savings on repeated queries).",
    "- **Decision:** Store durable context in `.ashlrcode/genome/` keyed by the",
    "  manifest so retrieval stays cheap and deterministic.",
    "- **Consequences:** Agents must keep the genome current as the project evolves.",
    "  Stale knowledge sections degrade retrieval quality.",
    "",
    "---",
    "",
    "## ADR-NNNN: _Template_",
    "",
    "- **Status:** Proposed | Accepted | Superseded",
    "- **Date:** YYYY-MM-DD",
    "- **Context:** …",
    "- **Decision:** …",
    "- **Consequences:** …",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

export interface InitResult {
  dir: string;
  genomePath: string;
  sectionsCreated: number;
  autoPopulated: string[]; // names of auto-populated files
  minimal: boolean;
}

export async function runInit(args: CliArgs): Promise<InitResult> {
  if (!args.dir) {
    throw new Error("--dir <path> is required");
  }
  const cwd = resolve(args.dir);
  if (!existsSync(cwd)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  if (genomeExists(cwd)) {
    if (!args.force) {
      throw new Error(
        `Genome already exists at ${genomeDir(cwd)}. Re-run with --force to overwrite.`,
      );
    }
    // Wipe and recreate.
    await rm(genomeDir(cwd), { recursive: true, force: true });
  }

  const project = basename(cwd) || "project";

  // Use core-efficiency's initGenome for the base scaffold.
  await initGenome(cwd, {
    project,
    vision:
      "_Describe the ultimate end-state of this project in one or two sentences. Edit this file — the agent reads it before every significant task._",
    milestone: "Initial setup",
  });

  // Always overwrite knowledge/decisions.md with our richer ADR stub.
  await writeSection(cwd, "knowledge/decisions.md", renderDecisionsMd(), {
    title: "Decisions",
    summary: "Architectural decision records with rationale",
    tags: ["knowledge", "decisions", "adr", "rationale"],
  });

  const autoPopulated: string[] = [];

  if (!args.minimal) {
    // Architecture — from baseline scan. Write to knowledge/architecture.md
    // (core-efficiency already creates vision/architecture.md; we layer a
    // concrete, scanned version under knowledge/ per the plugin's spec).
    try {
      const baseline = scan({ dir: cwd, noCache: true });
      await writeSection(
        cwd,
        "knowledge/architecture.md",
        renderArchitectureMd(baseline),
        {
          title: "Architecture (scanned)",
          summary: "Auto-populated architecture snapshot from baseline scan",
          tags: ["knowledge", "architecture", "scanned", "structure"],
        },
      );
      autoPopulated.push("architecture.md (from baseline scan)");
    } catch (e) {
      // Degrade gracefully — still write a stub so the section exists.
      await writeSection(
        cwd,
        "knowledge/architecture.md",
        `# Architecture\n\n> Baseline scan failed: ${String(e)}. Fill this in manually.\n`,
        {
          title: "Architecture",
          summary: "Architecture (scan failed, manual fill required)",
          tags: ["knowledge", "architecture", "stub"],
        },
      );
    }

    // Conventions
    const det = detectConventions(cwd);
    await writeSection(cwd, "knowledge/conventions.md", renderConventionsMd(det), {
      title: "Conventions",
      summary: "Auto-populated conventions detected from config files",
      tags: ["knowledge", "conventions", "style", "lint"],
    });
    autoPopulated.push("conventions.md (from config files)");
  } else {
    // Minimal mode: still create stubs so the 6-section contract holds.
    await writeSection(
      cwd,
      "knowledge/architecture.md",
      "# Architecture\n\n_Describe the high-level structure of this project._\n",
      {
        title: "Architecture",
        summary: "Architecture stub (minimal init)",
        tags: ["knowledge", "architecture", "stub"],
      },
    );
    await writeSection(
      cwd,
      "knowledge/conventions.md",
      "# Conventions\n\n_Capture lint/format/test conventions and team norms._\n",
      {
        title: "Conventions",
        summary: "Conventions stub (minimal init)",
        tags: ["knowledge", "conventions", "stub"],
      },
    );
  }

  const manifest = await loadManifest(cwd);
  const sectionsCreated = manifest ? manifest.sections.length : 0;

  return {
    dir: cwd,
    genomePath: genomeDir(cwd),
    sectionsCreated,
    autoPopulated,
    minimal: args.minimal,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatResult(r: InitResult): string {
  const lines: string[] = [];
  lines.push(`\u2713 Initialized genome at ${r.genomePath}/`);
  lines.push(
    `  sections created: ${r.sectionsCreated} (vision, strategies, knowledge, milestones, meta)`,
  );
  if (r.autoPopulated.length > 0) {
    lines.push(`  auto-populated:   ${r.autoPopulated.join(", ")}`);
  } else {
    lines.push(`  auto-populated:   (minimal — stubs only)`);
  }
  lines.push(
    `  next: edit ${r.genomePath}/vision/north-star.md with your project's north star`,
  );
  lines.push(
    `        then use ashlr__grep — it will now route through genome RAG for ~-84% savings`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await runInit(args);
    process.stdout.write(formatResult(result) + "\n");
    process.exit(0);
  } catch (e) {
    process.stderr.write(`ashlr genome-init: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
