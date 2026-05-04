/**
 * _genome-search.ts — Inverted-index layer over .ashlrcode/genome/knowledge/*.md
 *
 * Builds a token → sections map from the genome knowledge corpus. The index
 * is cached to ~/.ashlr/genome-index-<repoSha>.cache (JSON) and invalidated
 * when the genome dir's mtime, file count, or sample filenames change.
 *
 * Design constraints:
 *   - Pure mechanical — zero LLM calls.
 *   - Build cost < 50ms for the 248KB corpus.
 *   - Thread-safe via a simple per-repoRoot in-process singleton.
 *   - Never throws — callers should degrade gracefully on index failure.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { readdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenomeSearchResult {
  /** The section header (e.g. "## Architecture decisions") */
  section: string;
  /** Absolute path to the .md file */
  file: string;
  /** 1-based line number of the section header */
  line: number;
  /** First non-empty content line(s) of the section (up to 200 chars) */
  snippet: string;
}

export interface GenomeSearchIndex {
  lookup(pattern: string | RegExp): GenomeSearchResult[];
  isComplete(): boolean;
  invalidate(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface IndexEntry {
  token: string;
  results: GenomeSearchResult[];
}

interface CacheShape {
  /** Fingerprint of the genome dir state when this cache was built. */
  fingerprint: string;
  /** Map of lowercased token → results. Stored as entries array for JSON. */
  entries: IndexEntry[];
  builtAt: number;
}

interface InMemoryIndex {
  fingerprint: string;
  map: Map<string, GenomeSearchResult[]>;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = join(process.env.HOME ?? homedir(), ".ashlr");
const MIN_TOKEN_LEN = 3;
const MAX_SNIPPET_LEN = 200;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a cheap fingerprint of the genome knowledge dir:
 *   SHA-256 of (total mtime of all md files + file count + sorted filenames sample)
 */
function fingerprintGenomeDir(knowledgeDir: string): string {
  try {
    if (!existsSync(knowledgeDir)) return "empty";
    const files = listMdFiles(knowledgeDir);
    if (files.length === 0) return "empty";
    let mtimeSum = 0;
    for (const f of files) {
      try {
        mtimeSum += statSync(f).mtimeMs;
      } catch {
        // ignore
      }
    }
    const sampleNames = files
      .slice(0, 10)
      .map((f) => f.split("/").pop() ?? "")
      .sort()
      .join("|");
    const raw = `${mtimeSum}:${files.length}:${sampleNames}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } catch {
    return "error";
  }
}

function listMdFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...listMdFiles(full));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        results.push(full);
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Cache path (per-repo, keyed by SHA of repo root path)
// ---------------------------------------------------------------------------

function cachePathFor(repoRoot: string): string {
  const repoSha = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return join(CACHE_DIR, `genome-index-${repoSha}.cache`);
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Parse a single .md file into sections. Each section starts at a `##` header
 * (we skip `#` top-level titles). Returns array of parsed sections.
 */
function parseMdSections(
  filePath: string,
): Array<{ header: string; line: number; body: string }> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const sections: Array<{ header: string; line: number; body: string }> = [];
  let current: { header: string; line: number; bodyLines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match ## or deeper headers
    if (/^#{2,}\s+/.test(line)) {
      if (current) {
        sections.push({
          header: current.header,
          line: current.line,
          body: current.bodyLines.join("\n"),
        });
      }
      current = { header: line.replace(/^#+\s+/, "").trim(), line: i + 1, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) {
    sections.push({
      header: current.header,
      line: current.line,
      body: current.bodyLines.join("\n"),
    });
  }
  return sections;
}

/**
 * Tokenize a string into lowercase alpha-numeric tokens of length >= MIN_TOKEN_LEN.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

function extractSnippet(body: string): string {
  const firstMeaningfulLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
  if (!firstMeaningfulLine) return "";
  return firstMeaningfulLine.slice(0, MAX_SNIPPET_LEN);
}

/**
 * Build the full inverted index from the knowledge dir.
 * Returns a Map<token, GenomeSearchResult[]>.
 */
function buildIndex(knowledgeDir: string): Map<string, GenomeSearchResult[]> {
  const map = new Map<string, GenomeSearchResult[]>();
  const files = listMdFiles(knowledgeDir);

  for (const file of files) {
    const sections = parseMdSections(file);
    for (const sec of sections) {
      const result: GenomeSearchResult = {
        section: sec.header,
        file,
        line: sec.line,
        snippet: extractSnippet(sec.body),
      };
      // Index tokens from both header and body
      const tokens = new Set([
        ...tokenize(sec.header),
        ...tokenize(sec.body),
      ]);
      for (const token of tokens) {
        const existing = map.get(token);
        if (existing) {
          existing.push(result);
        } else {
          map.set(token, [result]);
        }
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Cache persistence
// ---------------------------------------------------------------------------

function loadCache(cachePath: string): CacheShape | null {
  try {
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, "utf-8");
    return JSON.parse(raw) as CacheShape;
  } catch {
    return null;
  }
}

function saveCache(cachePath: string, fingerprint: string, map: Map<string, GenomeSearchResult[]>): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const entries: IndexEntry[] = [];
    for (const [token, results] of map.entries()) {
      entries.push({ token, results });
    }
    const shape: CacheShape = {
      fingerprint,
      entries,
      builtAt: Date.now(),
    };
    writeFileSync(cachePath, JSON.stringify(shape), "utf-8");
  } catch {
    // Cache write failure is non-fatal — index is still usable in memory.
  }
}

function cacheToMap(cache: CacheShape): Map<string, GenomeSearchResult[]> {
  const map = new Map<string, GenomeSearchResult[]>();
  for (const entry of cache.entries) {
    map.set(entry.token, entry.results);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-repoRoot singleton registry
// ---------------------------------------------------------------------------

const _indexRegistry = new Map<string, InMemoryIndex>();

function getOrBuildIndex(repoRoot: string): InMemoryIndex {
  const knowledgeDir = join(repoRoot, ".ashlrcode", "genome", "knowledge");
  const fingerprint = fingerprintGenomeDir(knowledgeDir);
  const cachePath = cachePathFor(repoRoot);

  const existing = _indexRegistry.get(repoRoot);
  if (existing && existing.fingerprint === fingerprint && existing.complete) {
    return existing;
  }

  // Try loading from disk cache.
  const cached = loadCache(cachePath);
  if (cached && cached.fingerprint === fingerprint) {
    const map = cacheToMap(cached);
    const idx: InMemoryIndex = { fingerprint, map, complete: true };
    _indexRegistry.set(repoRoot, idx);
    return idx;
  }

  // Cache miss or stale — rebuild.
  const map = buildIndex(knowledgeDir);
  saveCache(cachePath, fingerprint, map);
  const idx: InMemoryIndex = { fingerprint, map, complete: true };
  _indexRegistry.set(repoRoot, idx);
  return idx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deduplicate results by (file, line) to avoid returning the same section
 * multiple times when multiple tokens from a pattern match it.
 */
function dedupeResults(results: GenomeSearchResult[]): GenomeSearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getGenomeSearchIndex(repoRoot: string): GenomeSearchIndex {
  return {
    lookup(pattern: string | RegExp): GenomeSearchResult[] {
      try {
        const idx = getOrBuildIndex(repoRoot);
        const results: GenomeSearchResult[] = [];

        if (pattern instanceof RegExp) {
          // For RegExp: scan all tokens whose key matches the pattern, or
          // do a full scan of all results for content matching.
          for (const [token, entries] of idx.map.entries()) {
            if (pattern.test(token)) {
              results.push(...entries);
            }
          }
          // Also filter by testing snippet + section against the regex
          const byContent: GenomeSearchResult[] = [];
          const seen = new Set<string>();
          for (const [, entries] of idx.map.entries()) {
            for (const entry of entries) {
              const key = `${entry.file}:${entry.line}`;
              if (seen.has(key)) continue;
              if (pattern.test(entry.section) || pattern.test(entry.snippet)) {
                seen.add(key);
                byContent.push(entry);
              }
            }
          }
          results.push(...byContent);
        } else {
          // String pattern: tokenize it, then intersect (AND semantics for
          // multi-token patterns; OR fallback for single token).
          const tokens = tokenize(pattern);
          if (tokens.length === 0) return [];

          if (tokens.length === 1) {
            const token = tokens[0]!;
            // Exact match first, then prefix match.
            const exact = idx.map.get(token) ?? [];
            results.push(...exact);
            // Also search for the raw pattern as substring in section/snippet
            const lower = pattern.toLowerCase();
            for (const [, entries] of idx.map.entries()) {
              for (const entry of entries) {
                if (
                  entry.section.toLowerCase().includes(lower) ||
                  entry.snippet.toLowerCase().includes(lower)
                ) {
                  results.push(entry);
                }
              }
            }
          } else {
            // Multi-token: find results that appear in ALL token sets (AND).
            const sets = tokens.map((t) => new Set((idx.map.get(t) ?? []).map((r) => `${r.file}:${r.line}`)));
            const intersection = sets.reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
            for (const key of intersection) {
              // Retrieve one result for this key from any set.
              const entry = (idx.map.get(tokens[0]!) ?? []).find((r) => `${r.file}:${r.line}` === key);
              if (entry) results.push(entry);
            }
          }
        }

        return dedupeResults(results);
      } catch {
        return [];
      }
    },

    isComplete(): boolean {
      const existing = _indexRegistry.get(repoRoot);
      return existing?.complete ?? false;
    },

    invalidate(): void {
      _indexRegistry.delete(repoRoot);
      // Also remove disk cache.
      try {
        const cachePath = cachePathFor(repoRoot);
        if (existsSync(cachePath)) {
          require("fs").unlinkSync(cachePath);
        }
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Warm-start helper — called once on server startup (fire-and-forget)
// ---------------------------------------------------------------------------

export function warmGenomeIndex(repoRoot: string): void {
  try {
    getOrBuildIndex(repoRoot);
  } catch {
    // warmup must never throw
  }
}
