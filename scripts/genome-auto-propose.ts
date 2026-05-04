#!/usr/bin/env bun
/**
 * ashlr genome auto-propose — PostToolUse observer that writes structured
 * proposals to `.ashlrcode/genome/proposals.jsonl` when a tool result looks
 * architecturally interesting.
 *
 * Pipeline:
 *   1. Read PostToolUse JSON from stdin.
 *   2. Skip trivial tools; whitelist known-interesting ones.
 *   3. Regex-match architecture/decision signals on the result text.
 *   4. Dedup by SHA-256(first 500 chars) against a persisted Set capped at 10K.
 *   5. Walk up from cwd (or $PROJECT_ROOT) to find `.ashlrcode/genome`.
 *   6. Append a JSONL proposal with the current generation number.
 *
 * Design rules:
 *   - Never throw. Any error → silent exit 0 (never block the agent).
 *   - Respect ASHLR_GENOME_AUTO=0 and ~/.claude/settings.json + ~/.ashlr/config.json.
 *   - At most one proposal per invocation.
 */

import { createHash } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

// ---------------------------------------------------------------------------
// 5A Pre-filter constants
// ---------------------------------------------------------------------------

/** Size threshold above which the stdout-dump heuristic activates (50 KB). */
const STDOUT_DUMP_SIZE_THRESHOLD = 50 * 1024;

/** Path segments that indicate generated / vendored / tooling dirs. */
const FILTERED_PATH_SEGMENTS = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  "coverage/",
  ".git/",
  ".ashlrcode/",
];

/** How many recent proposals to check for content dedup (tail window). */
const RECENT_DEDUP_WINDOW = 5;

/** How many bytes to read from the tail of proposals.jsonl for recent dedup. */
const RECENT_DEDUP_TAIL_BYTES = 8 * 1024; // 8 KB

// Simple counter — incremented each time a proposal is filtered by 5A rules.
// Exposed via export for observability in tests; not persisted.
export let stats = { proposalsFiltered: 0 };

/** Reset stats — test helper only. */
export function _resetStats(): void {
  stats = { proposalsFiltered: 0 };
}

const SIGNAL_RE =
  /architecture|decision|ADR|convention|pattern|trade.?off|invariant|contract/i;

const WHITELIST = new Set<string>([
  "Read",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "ashlr__read",
  "ashlr__grep",
  "ashlr__edit",
]);

const TRIVIAL = new Set<string>(["TodoWrite", "ashlr__savings"]);

// Minimum text length to even consider proposing. Bumped from 200 → 400 in
// v1.13 after the 367-proposals-in-a-day audit showed ~200-char fragments
// were mostly captured code snippets with no architectural payload. 400
// roughly corresponds to a paragraph of prose + one code block.
const MIN_CONTENT_LEN = 400;
const MAX_SEEN = 10_000;
const SEEN_PATH = join(homedir(), ".ashlr", "genome-proposals-seen.json");

// Minimum manifest section count before the overlap gate kicks in. Below this,
// a genome is too fresh to have built a meaningful vocabulary and the gate
// would reject everything.
const MANIFEST_GATE_MIN_SECTIONS = 3;

// Tokens shorter than this aren't useful for overlap detection ("the", "and").
const MIN_OVERLAP_TOKEN_LEN = 5;

// English stopwords to drop from the manifest vocabulary so overlap matches
// are semantically meaningful. Small list; exact-match lowercase.
const OVERLAP_STOPWORDS = new Set<string>([
  "about", "after", "again", "against", "because", "before", "being",
  "between", "during", "from", "into", "onto", "other", "over", "some",
  "such", "than", "that", "their", "them", "these", "they", "this",
  "those", "through", "under", "with", "within", "without", "which",
  "while", "would", "could", "should", "shall", "might", "there",
  "here", "when", "where", "what", "how", "why", "your", "yours",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  tool_response?: unknown;
}

interface AshlrConfig {
  genomeAuto?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
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

function isInterestingTool(name: string | undefined): boolean {
  if (!name) return false;
  if (TRIVIAL.has(name)) return false;
  if (WHITELIST.has(name)) return true;
  // Match mcp__...ashlr__read/grep/edit MCP-prefixed variants.
  if (/ashlr__(read|grep|edit)$/.test(name)) return true;
  return false;
}

function extractText(payload: PostToolUsePayload): string {
  const candidates: unknown[] = [payload.tool_result, payload.tool_response];
  const parts: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string") {
      parts.push(c);
    } else if (typeof c === "object") {
      try {
        parts.push(JSON.stringify(c));
      } catch {
        /* ignore */
      }
    }
  }
  return parts.join("\n");
}

function findGenomeDir(start: string): string | null {
  let cur = resolve(start);
  // Walk up until filesystem root.
  while (true) {
    const candidate = join(cur, ".ashlrcode", "genome");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function currentGeneration(genomeDir: string): number {
  const manifestFile = join(genomeDir, "manifest.json");
  if (!existsSync(manifestFile)) return 1;
  try {
    const raw = JSON.parse(readFileSync(manifestFile, "utf-8")) as {
      generation?: { number?: number };
    };
    return raw.generation?.number ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Extract a vocabulary of meaningful tokens from a genome manifest —
 * section titles, tags, and summaries. Used as the second-gate filter so
 * auto-proposals only fire when the text overlaps something the project
 * already tracks.
 *
 * Returns a set of lowercased tokens ≥ {@link MIN_OVERLAP_TOKEN_LEN} chars.
 * Returns an empty set if the manifest can't be read or has too few
 * sections to build a useful vocabulary — the caller should then skip the
 * gate so fresh genomes aren't locked out.
 */
export function buildManifestVocabulary(genomeDir: string): Set<string> {
  const manifestFile = join(genomeDir, "manifest.json");
  if (!existsSync(manifestFile)) return new Set();
  let manifest: {
    sections?: Array<{ title?: string; tags?: string[]; summary?: string }>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
  } catch {
    return new Set();
  }
  const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
  if (sections.length < MANIFEST_GATE_MIN_SECTIONS) return new Set();

  const vocab = new Set<string>();
  const ingest = (raw: string | undefined): void => {
    if (!raw) return;
    for (const token of raw.toLowerCase().split(/[^a-z0-9_\-]+/)) {
      if (token.length < MIN_OVERLAP_TOKEN_LEN) continue;
      if (OVERLAP_STOPWORDS.has(token)) continue;
      vocab.add(token);
    }
  };
  for (const section of sections) {
    ingest(section.title);
    ingest(section.summary);
    if (Array.isArray(section.tags)) {
      for (const tag of section.tags) ingest(tag);
    }
  }
  return vocab;
}

/** `true` if `text` mentions at least one token in `vocabulary`. */
export function textOverlapsVocabulary(text: string, vocabulary: Set<string>): boolean {
  if (vocabulary.size === 0) return true; // gate disabled (fresh genome)
  const lower = text.toLowerCase();
  for (const token of vocabulary) {
    if (lower.includes(token)) return true;
  }
  return false;
}

/** Env / config override: `ASHLR_GENOME_REQUIRE_OVERLAP=0` skips the gate. */
function overlapGateEnabled(): boolean {
  return process.env.ASHLR_GENOME_REQUIRE_OVERLAP !== "0";
}

interface SeenCache {
  /** FIFO list of hashes; oldest at index 0, newest at end. */
  hashes: string[];
}

function loadSeen(): SeenCache {
  if (!existsSync(SEEN_PATH)) return { hashes: [] };
  try {
    const raw = JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && Array.isArray((raw as SeenCache).hashes)) {
      return { hashes: (raw as SeenCache).hashes.filter((h) => typeof h === "string") };
    }
  } catch {
    /* ignore */
  }
  return { hashes: [] };
}

function saveSeen(cache: SeenCache): void {
  try {
    mkdirSync(dirname(SEEN_PATH), { recursive: true });
    writeFileSync(SEEN_PATH, JSON.stringify(cache), "utf-8");
  } catch {
    /* ignore */
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** ULID-like sortable id. Not a strict ULID — good enough for dedup + ordering. */
function makeId(): string {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return `${ts}${rand}`;
}

function buildSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 400) return flat;
  return flat.slice(0, 400) + "…";
}

function buildRationale(toolName: string, text: string): string {
  const match = text.match(SIGNAL_RE);
  const keyword = match ? match[0] : "signal";
  return `Auto-observed ${keyword} in ${toolName} result; worth preserving for future sessions.`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5A Pre-filter helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this content look like a raw stdout dump?
 *
 * We look for 2+ of the following markers:
 *   - Shell prompt prefix `$ `
 *   - Exit status tokens `exit 0` / `exit 1`
 *   - Claude compact marker `[compact saved`
 *   - Duration suffix (e.g. `123ms`)
 *   - High density of lines that look like file-system paths (> 30% of sampled lines)
 *   - Many lines with only trailing whitespace / empty lines (> 40% of sampled lines)
 */
export function looksLikeStdoutDump(text: string): boolean {
  let score = 0;

  if (text.includes("$ ")) score += 1;
  if (/\bexit [01]\b/.test(text)) score += 1;
  if (text.includes("[compact saved")) score += 1;
  if (/\d+ms\b/.test(text)) score += 1;

  // Sample up to 200 lines for path / blank density checks.
  const lines = text.split("\n").slice(0, 200);
  const pathLike = lines.filter((l) => /^\s*(\/|~\/|\.\/|\.\.\/)/.test(l)).length;
  if (lines.length > 0 && pathLike / lines.length > 0.3) score += 1;

  const blankOrWhitespace = lines.filter((l) => l.trim() === "").length;
  if (lines.length > 0 && blankOrWhitespace / lines.length > 0.4) score += 1;

  return score >= 2;
}

/**
 * Returns true if the source path of the proposal should be filtered out
 * (generated dirs, vendored code, genome internals).
 */
export function isFilteredPath(sourcePath: string | undefined): boolean {
  if (!sourcePath) return false;
  const normalized = sourcePath.replace(/\\/g, "/");
  return FILTERED_PATH_SEGMENTS.some((seg) => normalized.includes(seg));
}

/**
 * Returns true if `contentHash` matches one of the last
 * `RECENT_DEDUP_WINDOW` proposals in `proposalsPath`.
 *
 * Reads at most `RECENT_DEDUP_TAIL_BYTES` from the end of the file so it
 * stays fast even for large proposals.jsonl files.
 */
export function isRecentDuplicate(contentHash: string, proposalsPath: string): boolean {
  if (!existsSync(proposalsPath)) return false;
  try {
    // Read tail efficiently.
    const { openSync, fstatSync, readSync, closeSync } = require("fs") as typeof import("fs");
    const fd = openSync(proposalsPath, "r");
    const { size } = fstatSync(fd);
    const readStart = Math.max(0, size - RECENT_DEDUP_TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(RECENT_DEDUP_TAIL_BYTES, size));
    const bytesRead = readSync(fd, buf, 0, buf.length, readStart);
    closeSync(fd);
    const tail = buf.slice(0, bytesRead).toString("utf-8");

    // Parse JSONL lines (last RECENT_DEDUP_WINDOW complete ones).
    const lines = tail.split("\n").filter((l) => l.trim());
    const recent = lines.slice(-RECENT_DEDUP_WINDOW);
    for (const line of recent) {
      try {
        const rec = JSON.parse(line) as { contentHash?: string };
        if (rec.contentHash === contentHash) return true;
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch {
    // On any I/O error, allow the proposal through.
  }
  return false;
}

/**
 * Compute the normalized-content hash used by the recent-dedup window.
 * Normalized = collapse whitespace so minor whitespace differences don't
 * bypass dedup.
 */
export function normalizedContentHash(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return sha256(normalized);
}

export interface ProposeOptions {
  cwd?: string;
  seenPath?: string;
}

export interface ProposeOutcome {
  wrote: boolean;
  reason: string;
  proposalId?: string;
  genomeDir?: string;
}

export function shouldPropose(payload: PostToolUsePayload): {
  ok: boolean;
  reason: string;
  text: string;
} {
  if (!isAutoEnabled()) return { ok: false, reason: "auto-disabled", text: "" };
  if (!isInterestingTool(payload.tool_name)) {
    return { ok: false, reason: "tool-not-whitelisted", text: "" };
  }
  const text = extractText(payload);
  if (text.length < MIN_CONTENT_LEN) {
    return { ok: false, reason: "content-too-short", text };
  }
  if (!SIGNAL_RE.test(text)) return { ok: false, reason: "no-signal", text };
  return { ok: true, reason: "match", text };
}

export function runPropose(
  payload: PostToolUsePayload,
  opts: ProposeOptions = {},
): ProposeOutcome {
  const decision = shouldPropose(payload);
  if (!decision.ok) return { wrote: false, reason: decision.reason };

  // -------------------------------------------------------------------------
  // 5A Pre-filter gate (runs before genome lookup to fail fast)
  // -------------------------------------------------------------------------

  // 1. Stdout-dump heuristic: large payloads that look like raw tool output.
  if (decision.text.length > STDOUT_DUMP_SIZE_THRESHOLD && looksLikeStdoutDump(decision.text)) {
    stats.proposalsFiltered += 1;
    process.stderr.write("[ashlr:genome-propose] filtered: stdout-dump heuristic\n");
    return { wrote: false, reason: "filtered-stdout-dump" };
  }

  // 2. Path filter: source path contains generated/vendored directories.
  const sourcePath =
    typeof (payload.tool_input as Record<string, unknown> | undefined)?.path === "string"
      ? (payload.tool_input as Record<string, string>).path
      : undefined;
  if (isFilteredPath(sourcePath)) {
    stats.proposalsFiltered += 1;
    process.stderr.write("[ashlr:genome-propose] filtered: path in excluded dir\n");
    return { wrote: false, reason: "filtered-path" };
  }

  const startCwd =
    opts.cwd ?? process.env.PROJECT_ROOT ?? process.cwd();
  const genomeDir = findGenomeDir(startCwd);
  if (!genomeDir) {
    return { wrote: false, reason: "no-genome" };
  }

  // 3. Recent-dedup window: check last 5 proposals for content match.
  const proposalsPath = join(genomeDir, "proposals.jsonl");
  const contentHash = normalizedContentHash(decision.text);
  if (isRecentDuplicate(contentHash, proposalsPath)) {
    stats.proposalsFiltered += 1;
    process.stderr.write("[ashlr:genome-propose] filtered: recent-dedup window hit\n");
    return { wrote: false, reason: "filtered-recent-dedup" };
  }

  // -------------------------------------------------------------------------
  // Existing gates (manifest overlap + global dedup seen-set)
  // -------------------------------------------------------------------------

  // Manifest-overlap gate: require the proposal to mention something the
  // project already tracks. Skipped for fresh genomes (vocab empty when
  // manifest has < MANIFEST_GATE_MIN_SECTIONS) or via env override.
  if (overlapGateEnabled()) {
    const vocab = buildManifestVocabulary(genomeDir);
    if (!textOverlapsVocabulary(decision.text, vocab)) {
      return { wrote: false, reason: "no-manifest-overlap", genomeDir };
    }
  }

  // Dedup via SHA-256 of first 500 chars.
  const head = decision.text.slice(0, 500);
  const hash = sha256(head);
  const seenPath = opts.seenPath ?? SEEN_PATH;
  const seen = loadSeenFrom(seenPath);
  if (seen.hashes.includes(hash)) {
    return { wrote: false, reason: "dedup" };
  }
  seen.hashes.push(hash);
  while (seen.hashes.length > MAX_SEEN) seen.hashes.shift();
  saveSeenTo(seenPath, seen);

  const generation = currentGeneration(genomeDir);
  const proposal = {
    id: makeId(),
    agentId: "claude-code",
    section: "knowledge/discoveries.md",
    operation: "append" as const,
    content: buildSummary(decision.text),
    rationale: buildRationale(payload.tool_name ?? "unknown", decision.text),
    timestamp: new Date().toISOString(),
    generation,
    contentHash,
  };

  try {
    appendFileSync(proposalsPath, JSON.stringify(proposal) + "\n", "utf-8");
    return {
      wrote: true,
      reason: "appended",
      proposalId: proposal.id,
      genomeDir,
    };
  } catch {
    return { wrote: false, reason: "write-failed", genomeDir };
  }
}

function loadSeenFrom(path: string): SeenCache {
  if (path === SEEN_PATH) return loadSeen();
  if (!existsSync(path)) return { hashes: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && Array.isArray((raw as SeenCache).hashes)) {
      return { hashes: (raw as SeenCache).hashes.filter((h) => typeof h === "string") };
    }
  } catch {
    /* ignore */
  }
  return { hashes: [] };
}

function saveSeenTo(path: string, cache: SeenCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf-8");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let payload: PostToolUsePayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as PostToolUsePayload;
  } catch {
    // Bad input — exit silently. Never block the agent.
    process.exit(0);
  }
  try {
    runPropose(payload);
  } catch {
    /* swallow */
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
