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

import { existsSync, readdirSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { basename, join, resolve } from "path";
import { execSync } from "child_process";
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
  summarize: boolean; // use local model (Ollama) for CLAUDE.md summaries
}

export function parseArgs(argv: string[]): CliArgs {
  let dir: string | undefined;
  let force = false;
  let minimal = false;
  let summarize = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (a === "--force") force = true;
    else if (a === "--minimal") minimal = true;
    else if (a === "--summarize") summarize = true;
  }
  return { dir, force, minimal, summarize };
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
// Project discovery — scan child directories for related projects
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
  name: string;
  path: string;
  isGitRepo: boolean;
  remoteUrl?: string; // origin remote URL
  org?: string; // GitHub org/owner extracted from remote
  repoName?: string; // repo name extracted from remote
  hasClaudeMd: boolean;
  claudeMdSummary?: string; // first ~500 chars of CLAUDE.md
  hasClaudeDir: boolean;
  hasGenome: boolean;
}

export interface WorkspaceGraph {
  rootDir: string;
  projects: DiscoveredProject[];
  orgs: Map<string, DiscoveredProject[]>; // grouped by GitHub org
}

// ---------------------------------------------------------------------------
// Local model summarization (Ollama)
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_TIMEOUT_MS = 2000;
const OLLAMA_GENERATE_TIMEOUT_MS = 30000;

/** Preferred models in order — use the first one available. */
const PREFERRED_MODELS = ["llama3.2:3b", "llama3.2:1b", "gemma4:12b", "gemma4:26b", "qwen2.5:3b"];

let resolvedModel: string | null = null;

/**
 * Check if Ollama is running and find the best available model.
 * Returns the model name or null if unavailable.
 */
async function resolveOllamaModel(): Promise<string | null> {
  if (resolvedModel !== null) return resolvedModel;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const available = new Set((data.models ?? []).map((m) => m.name));
    // Pick first preferred model that's available
    for (const model of PREFERRED_MODELS) {
      if (available.has(model)) {
        resolvedModel = model;
        return model;
      }
    }
    // Fall back to first available model
    const first = data.models?.[0]?.name;
    resolvedModel = first ?? null;
    return resolvedModel;
  } catch {
    return null;
  }
}

/**
 * Summarize text using a local Ollama model.
 * Returns null on failure — caller falls back to truncation.
 */
async function summarizeWithOllama(
  text: string,
  projectName: string,
  model: string,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_GENERATE_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a concise technical summarizer. Respond with exactly 2-3 sentences. No headers, no bullet points, no markdown.",
          },
          {
            role: "user",
            content: `Summarize this CLAUDE.md project file for "${projectName}". What is the project, what's the tech stack, and what's its current status?\n\n${text.slice(0, 3000)}`,
          },
        ],
        stream: false,
        options: { num_predict: 200, temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Extract org and repo name from a GitHub remote URL. */
function parseGitRemote(url: string): { org: string; repo: string } | null {
  // https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { org: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { org: sshMatch[1], repo: sshMatch[2] };
  return null;
}

/** Read the first ~500 chars of a CLAUDE.md as a summary. */
function readClaudeMdSummary(filePath: string): string {
  try {
    const raw = readFileSync(filePath, "utf-8");
    // Strip frontmatter if present
    let content = raw;
    if (content.startsWith("---")) {
      const end = content.indexOf("---", 3);
      if (end !== -1) content = content.slice(end + 3).trimStart();
    }
    // Take first ~500 chars, break at last newline
    if (content.length > 500) {
      const cut = content.lastIndexOf("\n", 500);
      content = content.slice(0, cut > 200 ? cut : 500) + "\n…";
    }
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Scan immediate child directories for git repos, CLAUDE.md files, and genomes.
 * Depth-limited to 1 level. Skips hidden dirs, node_modules, etc.
 * When `summarize` is true and Ollama is available, uses a local model
 * to generate concise CLAUDE.md summaries instead of truncating.
 */
export async function discoverProjects(
  dir: string,
  opts: { summarize?: boolean } = {},
): Promise<WorkspaceGraph> {
  const projects: DiscoveredProject[] = [];
  const skipDirs = new Set([
    "node_modules", "dist", "build", "coverage", ".Trash",
    ".git", "__pycache__", ".next", ".turbo",
  ]);

  // Check Ollama availability upfront if summarize requested
  let ollamaModel: string | null = null;
  if (opts.summarize) {
    ollamaModel = await resolveOllamaModel();
    if (!ollamaModel) {
      process.stderr.write(
        "ashlr genome-init: --summarize requested but Ollama is not running or has no models. Falling back to truncation.\n",
      );
    }
  }

  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" }) as import("fs").Dirent[];
  } catch {
    return { rootDir: dir, projects: [], orgs: new Map() };
  }

  // Phase 1: Collect project metadata (fast, sync)
  interface PendingProject {
    name: string;
    path: string;
    isGitRepo: boolean;
    remoteUrl?: string;
    org?: string;
    repoName?: string;
    hasClaudeMd: boolean;
    hasClaudeDir: boolean;
    hasGenome: boolean;
    claudeMdPath?: string;
  }
  const pending: PendingProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;

    const childPath = join(dir, entry.name);
    const isGitRepo = existsSync(join(childPath, ".git"));

    // Git remote
    let remoteUrl: string | undefined;
    let org: string | undefined;
    let repoName: string | undefined;
    if (isGitRepo) {
      try {
        const remote = execSync("git remote get-url origin", {
          cwd: childPath,
          timeout: 3000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        remoteUrl = remote;
        const parsed = parseGitRemote(remote);
        if (parsed) {
          org = parsed.org;
          repoName = parsed.repo;
        }
      } catch {
        // No remote or git error — skip
      }
    }

    const claudeMdPath = join(childPath, "CLAUDE.md");
    const hasClaudeMd = existsSync(claudeMdPath);
    const hasClaudeDir = existsSync(join(childPath, ".claude"));
    const hasGenome = existsSync(join(childPath, ".ashlrcode", "genome", "manifest.json"));

    pending.push({
      name: entry.name,
      path: childPath,
      isGitRepo,
      remoteUrl,
      org,
      repoName,
      hasClaudeMd,
      hasClaudeDir,
      hasGenome,
      claudeMdPath: hasClaudeMd ? claudeMdPath : undefined,
    });
  }

  // Phase 2: Generate CLAUDE.md summaries (parallel with Ollama, or sync truncation)
  const PARALLEL_BATCH = 4;
  const summaryMap = new Map<string, string>();

  if (ollamaModel) {
    // Run Ollama summarizations in parallel batches
    const toSummarize = pending.filter((p) => p.claudeMdPath);
    for (let i = 0; i < toSummarize.length; i += PARALLEL_BATCH) {
      const batch = toSummarize.slice(i, i + PARALLEL_BATCH);
      const results = await Promise.all(
        batch.map(async (p) => {
          const raw = readFileSync(p.claudeMdPath!, "utf-8");
          const llm = await summarizeWithOllama(raw, p.name, ollamaModel!);
          return { name: p.name, summary: llm ?? readClaudeMdSummary(p.claudeMdPath!) };
        }),
      );
      for (const r of results) {
        if (r.summary) summaryMap.set(r.name, r.summary);
      }
    }
  } else {
    // Fast path: truncation only
    for (const p of pending) {
      if (p.claudeMdPath) {
        const summary = readClaudeMdSummary(p.claudeMdPath);
        if (summary) summaryMap.set(p.name, summary);
      }
    }
  }

  // Phase 3: Build final project list
  for (const p of pending) {
    projects.push({
      name: p.name,
      path: p.path,
      isGitRepo: p.isGitRepo,
      remoteUrl: p.remoteUrl,
      org: p.org,
      repoName: p.repoName,
      hasClaudeMd: p.hasClaudeMd,
      claudeMdSummary: summaryMap.get(p.name),
      hasClaudeDir: p.hasClaudeDir,
      hasGenome: p.hasGenome,
    });
  }

  // Group by org
  const orgs = new Map<string, DiscoveredProject[]>();
  for (const p of projects) {
    if (p.org) {
      const list = orgs.get(p.org) || [];
      list.push(p);
      orgs.set(p.org, list);
    }
  }

  return { rootDir: dir, projects, orgs };
}

// ---------------------------------------------------------------------------
// Workspace markdown renderer
// ---------------------------------------------------------------------------

export function renderWorkspaceMd(graph: WorkspaceGraph): string {
  const lines: string[] = [];
  lines.push("# Workspace");
  lines.push("");
  lines.push(
    "> Auto-discovered from child directories at genome init. This helps the",
    "> agent understand which projects live in this workspace and how they relate.",
  );
  lines.push("");

  // Summary
  const gitRepos = graph.projects.filter((p) => p.isGitRepo);
  const withContext = graph.projects.filter((p) => p.hasClaudeMd || p.hasClaudeDir);
  const withGenome = graph.projects.filter((p) => p.hasGenome);
  lines.push(`- **Total directories:** ${graph.projects.length}`);
  lines.push(`- **Git repositories:** ${gitRepos.length}`);
  lines.push(`- **Projects with CLAUDE.md or .claude/:** ${withContext.length}`);
  if (withGenome.length > 0) {
    lines.push(`- **Projects with genome:** ${withGenome.length}`);
  }
  lines.push("");

  // Org grouping
  if (graph.orgs.size > 0) {
    lines.push("## Organizations");
    lines.push("");
    for (const [orgName, orgProjects] of [...graph.orgs.entries()].sort()) {
      lines.push(`### ${orgName} (${orgProjects.length} repos)`);
      lines.push("");
      for (const p of orgProjects.sort((a, b) => a.name.localeCompare(b.name))) {
        const badges: string[] = [];
        if (p.hasClaudeMd) badges.push("CLAUDE.md");
        if (p.hasGenome) badges.push("genome");
        const suffix = badges.length > 0 ? ` — ${badges.join(", ")}` : "";
        lines.push(`- **${p.name}** → \`${p.repoName || p.name}\`${suffix}`);
      }
      lines.push("");
    }
  }

  // Ungrouped / no-remote projects
  const ungrouped = graph.projects.filter((p) => !p.org);
  if (ungrouped.length > 0) {
    lines.push("## Local-only (no GitHub remote)");
    lines.push("");
    for (const p of ungrouped.sort((a, b) => a.name.localeCompare(b.name))) {
      const badges: string[] = [];
      if (p.isGitRepo) badges.push("git");
      if (p.hasClaudeMd) badges.push("CLAUDE.md");
      if (p.hasGenome) badges.push("genome");
      const suffix = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
      lines.push(`- **${p.name}**${suffix}`);
    }
    lines.push("");
  }

  // CLAUDE.md summaries for projects that have them
  const withSummaries = graph.projects.filter(
    (p) => p.claudeMdSummary && p.claudeMdSummary.length > 0,
  );
  if (withSummaries.length > 0) {
    lines.push("## Project Context (from CLAUDE.md files)");
    lines.push("");
    for (const p of withSummaries.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`### ${p.name}`);
      lines.push("");
      // Cap at 500 chars — LLM summaries are short (~200-400 chars) and pass through;
      // truncated raw content may be longer and gets capped here.
      const summary = p.claudeMdSummary!;
      if (summary.length > 500) {
        lines.push(summary.slice(0, 500) + "…");
      } else {
        lines.push(summary);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
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
  usedOllama: boolean;
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

    // Workspace discovery — scan child dirs for related projects
    try {
      const graph = await discoverProjects(cwd, { summarize: args.summarize });
      if (graph.projects.length > 0) {
        const gitCount = graph.projects.filter((p) => p.isGitRepo).length;
        const claudeCount = graph.projects.filter((p) => p.hasClaudeMd || p.hasClaudeDir).length;

        await writeSection(
          cwd,
          "knowledge/workspace.md",
          renderWorkspaceMd(graph),
          {
            title: "Workspace (discovered)",
            summary: `${gitCount} git repos and ${claudeCount} projects with CLAUDE.md discovered in workspace`,
            tags: [
              "knowledge", "workspace", "projects", "related",
              // Include org names as tags for retrieval
              ...[...graph.orgs.keys()],
            ],
          },
        );
        autoPopulated.push(
          `workspace.md (${gitCount} repos, ${claudeCount} with context)`,
        );
      }
    } catch {
      // Workspace discovery is best-effort — don't fail init
    }
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
    usedOllama: args.summarize,
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
  if (r.usedOllama && resolvedModel) {
    lines.push(`  summaries:        via local model (${resolvedModel})`);
  }
  const hasWorkspace = r.autoPopulated.some((s) => s.startsWith("workspace.md"));
  lines.push(
    `  next: edit ${r.genomePath}/vision/north-star.md with your project's north star`,
  );
  if (hasWorkspace) {
    lines.push(
      `        review ${r.genomePath}/knowledge/workspace.md for discovered projects`,
    );
  }
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
