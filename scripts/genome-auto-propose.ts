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

  const startCwd =
    opts.cwd ?? process.env.PROJECT_ROOT ?? process.cwd();
  const genomeDir = findGenomeDir(startCwd);
  if (!genomeDir) {
    return { wrote: false, reason: "no-genome" };
  }

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
  };

  const proposalsPath = join(genomeDir, "proposals.jsonl");
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
