#!/usr/bin/env bun
/**
 * genome-synthesizer — Q2 AI-Native Synthesis MVP entry point.
 *
 * Background LLM pass that converts recent commit sections + relevant static
 * sections into *discovery sections* — short, structured insights:
 *
 *   "3 files use this util wrong"
 *   "auth refactor introduced a flaky test pattern"
 *   "config X is duplicated across 4 modules"
 *
 * Tiered cadence (per WAD-D Q2 instrumentation plan):
 *   - free → synthesizer is gated off entirely (no LLM cost — hardcoded gate)
 *   - pro  → once per 7 days per repo (best-effort throttle)
 *   - team → once per 24 hours per repo (best-effort throttle)
 *
 * Output: 0-3 discovery sections per run, stored at
 *   `.ashlrcode/genome/discoveries/<id>.json`
 * plus a manifest entry with `kind: "discovery"` and `sourceTrust: "synthesis"`.
 *
 * State file: `.ashlrcode/genome/_synthesis-state.json` tracks the last run
 * timestamp so we don't double-run within the throttle window.
 *
 * Privacy:
 *   - We send commit-section summaries (which the user already authored as
 *     commit messages) — NEVER raw diff content.
 *   - Paths under `secrets/`, `.env`, or matching common secret patterns are
 *     redacted before going to the LLM.
 *
 * Usage:
 *   bun run scripts/genome-synthesizer.ts [--dry-run] [--max-commits=10] [--force] [--cwd <dir>]
 *
 * Flags:
 *   --dry-run       Parse + score + prompt, but don't write to disk.
 *                   Returns the would-be discovery list.
 *   --max-commits   How many recent commit sections to feed in (default 10).
 *   --force         Bypass the throttle window. Manual-run escape hatch.
 *   --cwd <dir>     Target a project other than process.cwd().
 *
 * Design constraints:
 *   - NEVER runs in a hook hot path. CLI-only.
 *   - Free tier MUST NEVER make an LLM call — gated at the very top.
 *   - No new external dependencies. Reuses `servers/_llm-providers/` only.
 *   - Best-effort throttle — if the state file is corrupt we re-synthesize.
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

import {
  DISCOVERIES_SUBDIR,
  DISCOVERY_RETENTION_LIMIT,
  commitSectionAbsPath,
  discoverySectionAbsPath,
  loadManifestV2,
  saveManifestV2,
  writeDiscoverySectionFile,
  type CommitSection,
  type DiscoveryEvidence,
  type DiscoverySection,
  type GenomeManifestV2,
  type SectionMetaV2,
} from "../servers/_manifest-v2";
import { isProSync } from "../servers/_pro";
import { selectProvider, type LlmProvider } from "../servers/_llm-providers";
import { scoreSectionMeta, tokenize } from "../servers/_genome-commits";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "free" | "pro" | "team";

export interface SynthesizeOpts {
  /** Repo to synthesize. Defaults to process.cwd(). */
  cwd?: string;
  /** Tier — controls gating + throttle window. Defaults via isProSync(). */
  tier?: Tier;
  /** How many recent commit sections to feed in. Default 10. */
  maxCommits?: number;
  /** If true, never writes — returns what would be written. Default false. */
  dryRun?: boolean;
  /** If true, bypass the throttle window. Default false. */
  force?: boolean;
  /** Optional provider override (for tests). */
  provider?: LlmProvider;
  /** Optional clock override (for tests). */
  nowMs?: number;
}

export interface SynthesizeResult {
  skipped: boolean;
  reason?:
    | "free-tier"
    | "throttled"
    | "no-genome"
    | "no-commits"
    | "no-provider"
    | "llm-failed"
    | "no-discoveries-produced";
  writtenIds?: string[];
  wouldWriteIds?: string[];
  discoveries?: DiscoverySection[];
}

export interface SynthesisState {
  lastRunAt: string;     // ISO of most recent non-dryrun synthesize()
  lastTier: Tier;        // tier at last run
  lastDiscoveryCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = "_synthesis-state.json";
const THROTTLE_PRO_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const THROTTLE_TEAM_MS = 1 * 24 * 60 * 60 * 1000; // 24 hours

/** Hard cap on the number of discoveries written per run. */
const MAX_DISCOVERIES_PER_RUN = 3;

/** Minimum discoveries per run before we treat the run as successful. */
const MIN_DISCOVERIES_PER_RUN = 1;

const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?\//i,
  /credentials?\.json$/i,
  /\.pem$/i,
  /id_rsa(\.|$)/i,
];

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

function stateFilePath(cwd: string): string {
  return join(cwd, ".ashlrcode", "genome", STATE_FILE);
}

export async function readSynthesisState(cwd: string): Promise<SynthesisState | null> {
  const p = stateFilePath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as SynthesisState;
    if (typeof parsed.lastRunAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSynthesisState(cwd: string, state: SynthesisState): Promise<void> {
  const p = stateFilePath(cwd);
  if (!existsSync(dirname(p))) {
    await mkdir(dirname(p), { recursive: true });
  }
  const tmp = p + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmp, p);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export function resolveTier(opts: SynthesizeOpts): Tier {
  if (opts.tier) return opts.tier;
  // Default: read the cached pro-token state. We don't await network here —
  // the synthesizer runs offline. ASHLR_PRO_ASSUME (handled by isProSync)
  // still works as an escape hatch.
  if (isProSync()) {
    // We don't distinguish pro vs team here without an explicit signal.
    // Conservative default: treat cached-pro as "pro" tier so throttle is 7d.
    // Callers (or env ASHLR_TIER) can override to "team" for 24h.
    const envTier = (process.env.ASHLR_TIER ?? "").toLowerCase().trim();
    if (envTier === "team") return "team";
    return "pro";
  }
  return "free";
}

// ---------------------------------------------------------------------------
// Commit + static section loading
// ---------------------------------------------------------------------------

async function loadRecentCommitSections(
  cwd: string,
  manifest: GenomeManifestV2,
  maxCommits: number,
): Promise<CommitSection[]> {
  const commitMetas = manifest.sections
    .filter((s) => s.kind === "commit")
    .slice() // copy before mutating
    .sort((a, b) => {
      const ad = a.lastUpdatedAt ?? a.updatedAt;
      const bd = b.lastUpdatedAt ?? b.updatedAt;
      return bd > ad ? 1 : bd < ad ? -1 : 0;
    })
    .slice(0, maxCommits);

  const out: CommitSection[] = [];
  for (const meta of commitMetas) {
    const sha = meta.path.replace(/^commits\//, "").replace(/\.json$/, "");
    const abs = commitSectionAbsPath(cwd, sha);
    if (!existsSync(abs)) continue;
    try {
      const raw = await readFile(abs, "utf-8");
      out.push(JSON.parse(raw) as CommitSection);
    } catch {
      // skip corrupt — best-effort
    }
  }
  return out;
}

/**
 * Pick the static sections most relevant to the recent commits. Uses the
 * commit messages + filesChanged as the query corpus, then scores every
 * static section against that query.
 *
 * Returns up to `limit` static section metas (we don't load file bodies —
 * the LLM prompt only needs titles + summaries + tags).
 */
function selectRelevantStaticSections(
  manifest: GenomeManifestV2,
  commits: CommitSection[],
  limit = 5,
): SectionMetaV2[] {
  if (commits.length === 0) return [];
  const queryText = commits
    .map((c) => `${c.message} ${c.filesChanged.join(" ")}`)
    .join(" ");
  const queryTerms = new Set(tokenize(queryText));
  if (queryTerms.size === 0) return [];

  const statics = manifest.sections.filter((s) => s.kind === "static" || s.kind == null);
  const scored = statics
    .map((s) => ({ meta: s, score: scoreSectionMeta(s, queryTerms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => x.meta);
}

// ---------------------------------------------------------------------------
// Path redaction (privacy)
// ---------------------------------------------------------------------------

function redactSecretPaths(paths: string[]): string[] {
  return paths.map((p) => (SECRET_PATH_PATTERNS.some((rx) => rx.test(p)) ? "[redacted]" : p));
}

function redactCommit(c: CommitSection): CommitSection {
  return {
    ...c,
    filesChanged: redactSecretPaths(c.filesChanged),
    // The summary may contain raw diff paths from `git show --stat` — strip
    // lines that mention secret paths.
    summary: c.summary
      .split("\n")
      .filter((line) => !SECRET_PATH_PATTERNS.some((rx) => rx.test(line)))
      .join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildSynthesisPrompt(
  commits: CommitSection[],
  staticSections: SectionMetaV2[],
): { system: string; user: string } {
  const system = [
    "You are a code-archaeologist for a developer's project.",
    "Read the recent commits and static-genome summaries provided, then return",
    "up to 3 short, actionable *discoveries* — concise insights that a busy",
    "engineer would benefit from at a glance.",
    "",
    "Each discovery MUST be a JSON object with these fields:",
    `  - "summary":       1-2 sentence insight (string).`,
    `  - "evidence":      array of { "path": string, "lineRange"?: [number, number] }`,
    `                     using file paths drawn from the commits' filesChanged lists.`,
    `  - "sourceCommits": array of full git SHAs (strings) from the commits below`,
    `                     that inspired this discovery.`,
    `  - "confidence":    a number from 0 to 1 (your self-rated confidence).`,
    "",
    "Return ONLY a JSON array of those objects — no prose, no markdown fences,",
    "no commentary. If you have no high-quality discoveries, return [].",
  ].join("\n");

  const commitLines = commits.map((c) => {
    const firstLine = (c.message.split("\n")[0] ?? c.sha.slice(0, 7)).slice(0, 140);
    const files = c.filesChanged.slice(0, 8).join(", ");
    return `  - sha=${c.sha} date=${c.date.slice(0, 10)} subject=${JSON.stringify(firstLine)} files=[${files}]`;
  });

  const staticLines = staticSections.map((s) => {
    const tags = s.tags.slice(0, 6).join(", ");
    return `  - path=${s.path} title=${JSON.stringify(s.title)} tags=[${tags}] summary=${JSON.stringify((s.summary ?? "").slice(0, 160))}`;
  });

  const user = [
    "Recent commits (most recent first):",
    commitLines.length ? commitLines.join("\n") : "  (none)",
    "",
    "Relevant static genome sections:",
    staticLines.length ? staticLines.join("\n") : "  (none)",
    "",
    "Produce up to 3 discoveries as a JSON array.",
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

interface RawDiscovery {
  summary?: unknown;
  evidence?: unknown;
  sourceCommits?: unknown;
  confidence?: unknown;
}

/**
 * Strict-parse the LLM response into a list of valid discoveries.
 * Malformed entries are dropped; the returned list is never longer than
 * MAX_DISCOVERIES_PER_RUN.
 *
 * The synthesizer LLM may wrap its output in markdown fences ("```json") —
 * we strip those defensively.
 */
export function parseSynthesisResponse(
  raw: string,
  knownCommitShas: Set<string>,
): Array<Omit<DiscoverySection, "id" | "synthesizedAt">> {
  // Strip code fences if present.
  let stripped = raw.trim();
  if (stripped.startsWith("```")) {
    stripped = stripped.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/g, "").trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Array<Omit<DiscoverySection, "id" | "synthesizedAt">> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const it = item as RawDiscovery;

    const summary = typeof it.summary === "string" ? it.summary.trim() : "";
    if (!summary || summary.length < 8) continue;

    let evidence: DiscoveryEvidence[] = [];
    if (Array.isArray(it.evidence)) {
      for (const e of it.evidence) {
        if (!e || typeof e !== "object") continue;
        const path = typeof (e as { path?: unknown }).path === "string" ? (e as { path: string }).path : "";
        if (!path) continue;
        const range = (e as { lineRange?: unknown }).lineRange;
        let lineRange: [number, number] | undefined;
        if (
          Array.isArray(range) &&
          range.length === 2 &&
          typeof range[0] === "number" &&
          typeof range[1] === "number"
        ) {
          lineRange = [range[0], range[1]];
        }
        evidence.push(lineRange ? { path, lineRange } : { path });
      }
    }

    let sourceCommits: string[] = [];
    if (Array.isArray(it.sourceCommits)) {
      for (const c of it.sourceCommits) {
        if (typeof c === "string" && knownCommitShas.has(c)) sourceCommits.push(c);
      }
    }
    // Must reference at least one known commit — otherwise it's hallucinated.
    if (sourceCommits.length === 0) continue;

    let confidence = typeof it.confidence === "number" ? it.confidence : 0.5;
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    out.push({ summary, evidence, sourceCommits, confidence });
    if (out.length >= MAX_DISCOVERIES_PER_RUN) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stable ID hashing
// ---------------------------------------------------------------------------

function discoveryId(summary: string, sourceCommits: string[]): string {
  const h = createHash("sha256");
  h.update(summary.trim());
  h.update(" ");
  h.update([...sourceCommits].sort().join(","));
  return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Pruning (mirror commit-pruning policy)
// ---------------------------------------------------------------------------

async function pruneDiscoverySections(
  cwd: string,
  manifest: GenomeManifestV2,
): Promise<string[]> {
  const metas = manifest.sections.filter((s) => s.kind === "discovery");
  if (metas.length <= DISCOVERY_RETENTION_LIMIT) return [];

  const dated = metas.map((m) => {
    const id = m.path.replace(/^discoveries\//, "").replace(/\.json$/, "");
    return { meta: m, id, date: m.lastUpdatedAt ?? m.updatedAt };
  });
  dated.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  const keep = new Set(dated.slice(0, DISCOVERY_RETENTION_LIMIT).map((d) => d.meta.path));
  const dropped: string[] = [];
  for (const { meta, id } of dated) {
    if (keep.has(meta.path)) continue;
    dropped.push(id);
    const idx = manifest.sections.findIndex((s) => s.path === meta.path);
    if (idx >= 0) manifest.sections.splice(idx, 1);
    const abs = discoverySectionAbsPath(cwd, id);
    if (existsSync(abs)) await unlink(abs).catch(() => {});
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Main entry — synthesize()
// ---------------------------------------------------------------------------

/**
 * Run one synthesis pass.
 *
 * Hard gate order (early returns):
 *   1. Free tier → exit with `{skipped: true, reason: "free-tier"}`.
 *      This is the ONLY tier check that bypasses every other path; we never
 *      reach the LLM call for free users, even accidentally.
 *   2. No genome / no commits → skip with the matching reason.
 *   3. Throttled (and not --force) → skip.
 *   4. LLM provider unavailable → skip with `"no-provider"`.
 *   5. LLM call fails → skip with `"llm-failed"`.
 *   6. No valid discoveries parsed → skip with `"no-discoveries-produced"`.
 *
 * Otherwise: writes 0-3 discovery sections to disk + updates the manifest +
 * updates the state file (unless dry-run, in which case nothing is written).
 */
export async function synthesize(opts: SynthesizeOpts = {}): Promise<SynthesizeResult> {
  const cwd = opts.cwd ?? process.cwd();
  const tier = resolveTier(opts);
  const maxCommits = opts.maxCommits ?? 10;
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;
  const nowMs = opts.nowMs ?? Date.now();

  // -------- HARD GATE: free tier never calls the LLM -----------------------
  if (tier === "free") {
    return { skipped: true, reason: "free-tier" };
  }

  // -------- Genome present? ------------------------------------------------
  const manifest = await loadManifestV2(cwd);
  if (!manifest) {
    return { skipped: true, reason: "no-genome" };
  }

  // -------- Throttle window -----------------------------------------------
  if (!force && !dryRun) {
    const state = await readSynthesisState(cwd);
    if (state) {
      const ageMs = nowMs - new Date(state.lastRunAt).getTime();
      const windowMs = tier === "team" ? THROTTLE_TEAM_MS : THROTTLE_PRO_MS;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < windowMs) {
        return { skipped: true, reason: "throttled" };
      }
    }
  }

  // -------- Load + redact recent commits -----------------------------------
  const rawCommits = await loadRecentCommitSections(cwd, manifest, maxCommits);
  if (rawCommits.length === 0) {
    return { skipped: true, reason: "no-commits" };
  }
  const commits = rawCommits.map(redactCommit);
  const knownShas = new Set(commits.map((c) => c.sha));
  const staticSections = selectRelevantStaticSections(manifest, commits, 5);

  // -------- Build prompt + call LLM ----------------------------------------
  const { system, user } = buildSynthesisPrompt(commits, staticSections);
  const provider = opts.provider ?? (await selectProvider());
  if (provider.name === "none") {
    return { skipped: true, reason: "no-provider" };
  }

  let llmOutput: string;
  try {
    const result = await provider.summarize(user, system, { maxTokens: 800 });
    llmOutput = result.output;
  } catch {
    return { skipped: true, reason: "llm-failed" };
  }

  // -------- Parse + validate ----------------------------------------------
  const candidates = parseSynthesisResponse(llmOutput, knownShas);
  if (candidates.length < MIN_DISCOVERIES_PER_RUN) {
    return { skipped: true, reason: "no-discoveries-produced" };
  }

  const synthesizedAt = new Date(nowMs).toISOString();
  const discoveries: DiscoverySection[] = candidates.map((c) => ({
    id: discoveryId(c.summary, c.sourceCommits),
    summary: c.summary,
    evidence: c.evidence,
    sourceCommits: c.sourceCommits,
    synthesizedAt,
    confidence: c.confidence,
  }));

  // De-duplicate against existing discovery sections by ID.
  const existingIds = new Set(
    manifest.sections
      .filter((s) => s.kind === "discovery")
      .map((s) => s.path.replace(/^discoveries\//, "").replace(/\.json$/, "")),
  );
  const fresh = discoveries.filter((d) => !existingIds.has(d.id));

  // -------- Dry run: report would-be output ------------------------------
  if (dryRun) {
    return {
      skipped: false,
      wouldWriteIds: fresh.map((d) => d.id),
      discoveries: fresh,
    };
  }

  if (fresh.length === 0) {
    return { skipped: true, reason: "no-discoveries-produced" };
  }

  // -------- Persist + update manifest ------------------------------------
  for (const d of fresh) {
    const relPath = await writeDiscoverySectionFile(cwd, d);
    const meta: SectionMetaV2 = {
      path: relPath,
      title: `discovery ${d.id.slice(0, 7)} — ${d.summary.slice(0, 80)}`,
      summary: d.summary.slice(0, 240),
      tags: [
        "discovery",
        "synthesis",
        d.id.slice(0, 7),
        ...d.sourceCommits.map((s) => s.slice(0, 7)),
        ...d.evidence.slice(0, 5).map((e) => e.path.toLowerCase()),
      ],
      tokens: Math.ceil((d.summary.length + JSON.stringify(d.evidence).length) / 4),
      updatedAt: synthesizedAt,
      lastUpdatedAt: synthesizedAt,
      sourceTrust: "synthesis",
      confidence: d.confidence,
      kind: "discovery",
    };
    const idx = manifest.sections.findIndex((s) => s.path === relPath);
    if (idx >= 0) manifest.sections[idx] = meta;
    else manifest.sections.push(meta);
  }

  await pruneDiscoverySections(cwd, manifest);
  await saveManifestV2(cwd, manifest);

  await writeSynthesisState(cwd, {
    lastRunAt: synthesizedAt,
    lastTier: tier,
    lastDiscoveryCount: fresh.length,
  });

  return {
    skipped: false,
    writtenIds: fresh.map((d) => d.id),
    discoveries: fresh,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  cwd: string;
  dryRun: boolean;
  force: boolean;
  maxCommits: number;
  tier?: Tier;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let cwd = process.cwd();
  let dryRun = false;
  let force = false;
  let maxCommits = 10;
  let tier: Tier | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]!);
    else if (a.startsWith("--max-commits=")) {
      const v = parseInt(a.split("=")[1] ?? "", 10);
      if (Number.isFinite(v) && v > 0) maxCommits = v;
    } else if (a === "--max-commits" && argv[i + 1]) {
      const v = parseInt(argv[++i]!, 10);
      if (Number.isFinite(v) && v > 0) maxCommits = v;
    } else if (a.startsWith("--tier=")) {
      const t = a.split("=")[1] ?? "";
      if (t === "free" || t === "pro" || t === "team") tier = t;
    }
  }

  return { cwd, dryRun, force, maxCommits, tier };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const result = await synthesize({
    cwd: args.cwd,
    dryRun: args.dryRun,
    force: args.force,
    maxCommits: args.maxCommits,
    tier: args.tier,
  });

  // Human-readable status line — pipe-friendly for CI logs.
  if (result.skipped) {
    process.stderr.write(`[genome-synthesizer] skipped: ${result.reason ?? "unknown"}\n`);
    return 0;
  }
  const ids = result.writtenIds ?? result.wouldWriteIds ?? [];
  const verb = args.dryRun ? "would write" : "wrote";
  process.stderr.write(
    `[genome-synthesizer] ${verb} ${ids.length} discovery section(s): ${ids.join(", ")}\n`,
  );
  if (args.dryRun && result.discoveries) {
    process.stdout.write(JSON.stringify(result.discoveries, null, 2) + "\n");
  }
  return 0;
}

// Bun entry: invoke main when run directly.
// `import.meta.main` is bun-specific; falls back to a path check.
if (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (typeof (import.meta as any).main === "boolean" && (import.meta as any).main) ||
  (typeof process.argv[1] === "string" && process.argv[1].endsWith("genome-synthesizer.ts"))
) {
  void main().then((code) => process.exit(code));
}
