#!/usr/bin/env bun
/**
 * cli-orchestrate-status.ts — inspect past `/ashlr-orchestrate` runs.
 *
 * Reads `~/.ashlr/orchestrations/<graphId>/result.json` files persisted by
 * scripts/orchestrate-run.ts and renders either:
 *   - a table summarizing the last N runs (default), or
 *   - a per-node tree for a single run (when a graph-id is supplied), or
 *   - the raw JSON (when --json is passed).
 *
 * Pure / no-network / no-subprocess — safe to call from any shell.
 *
 * Usage:
 *   bun scripts/cli-orchestrate-status.ts                       # list last 10
 *   bun scripts/cli-orchestrate-status.ts <graph-id>            # detail
 *   bun scripts/cli-orchestrate-status.ts --json [<graph-id>]   # raw JSON
 *   bun scripts/cli-orchestrate-status.ts --last <N>            # list last N
 *
 * Designed for dependency injection: tests pass overrides for HOME, stdout,
 * and stderr so they can run in a tmp dir without touching the real ~/.ashlr/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types — mirror the shape persisted by orchestrate-run.ts. We intentionally
// duplicate (rather than import) so this CLI keeps a narrow dependency graph
// and tests don't have to wire the executor's DI seams just to read a file.
// ---------------------------------------------------------------------------

export interface PersistedNodeResult {
  id: string;
  nodeId?: string;
  ok: boolean;
  durationMs: number;
  tokens: number;
  tokensUsed?: number;
  output?: string;
  error?: string;
}

export interface PersistedRunResult {
  ok: boolean;
  graphId: string;
  startedAt: string;
  finishedAt?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalTokensUsed?: number;
  nodes?: PersistedNodeResult[];
  nodeResults?: PersistedNodeResult[];
  error?: string;
}

export interface PersistedGraphNode {
  id: string;
  agentKind?: string;
  goal?: string;
  scope?: string[];
  deps?: string[];
}

export interface PersistedGraph {
  id: string;
  goal: string;
  scope?: string;
  tier?: string;
  createdAt?: string;
  nodes: PersistedGraphNode[];
}

export interface PersistedRecord {
  graph: PersistedGraph;
  result: PersistedRunResult;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  graphId: string | null;
  json: boolean;
  last: number;
}

const DEFAULT_LAST = 10;

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { graphId: null, json: false, last: DEFAULT_LAST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
    } else if (a === "--last") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (Number.isFinite(n) && n > 0) out.last = n;
    } else if (a && !a.startsWith("--")) {
      out.graphId = a;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path traversal safety — graphId from CLI input is joined into a filesystem
// path, so it must be validated. We accept alphanumeric + hyphen + underscore
// only, with a sane length cap. Rejecting "." prevents `..`, `./`, and any
// absolute paths from sneaking through.
// ---------------------------------------------------------------------------

const SAFE_GRAPH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeGraphId(s: string): boolean {
  return SAFE_GRAPH_ID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Persistence root + record loading
// ---------------------------------------------------------------------------

function orchestrationsDir(home: string): string {
  return join(home, ".ashlr", "orchestrations");
}

interface LoadOptions {
  warn: (s: string) => void;
}

/**
 * Read a single result.json. Returns null + emits a stderr warning if the
 * file is missing OR malformed (caller can decide whether to skip or error).
 */
export function loadRecord(
  home: string,
  graphId: string,
  opts: LoadOptions,
): PersistedRecord | null {
  if (!isSafeGraphId(graphId)) {
    opts.warn(`warning: skipping unsafe graph id ${JSON.stringify(graphId)}\n`);
    return null;
  }
  const file = join(orchestrationsDir(home), graphId, "result.json");
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      opts.warn(`warning: malformed result.json at ${file} (not an object)\n`);
      return null;
    }
    if (!parsed.graph || !parsed.result) {
      opts.warn(`warning: malformed result.json at ${file} (missing graph/result)\n`);
      return null;
    }
    return parsed as PersistedRecord;
  } catch (e) {
    opts.warn(`warning: failed to read ${file}: ${(e as Error).message}\n`);
    return null;
  }
}

/**
 * List every run directory under ~/.ashlr/orchestrations/ and load each.
 * Skips malformed entries (with a stderr warning per skip).
 */
export function loadAllRecords(home: string, opts: LoadOptions): PersistedRecord[] {
  const dir = orchestrationsDir(home);
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    opts.warn(`warning: failed to read ${dir}: ${(e as Error).message}\n`);
    return [];
  }
  const records: PersistedRecord[] = [];
  for (const name of names) {
    const rec = loadRecord(home, name, opts);
    if (rec) records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function totalTokensOf(rec: PersistedRecord): number {
  const r = rec.result;
  if (typeof r.totalTokensUsed === "number") return r.totalTokensUsed;
  if (typeof r.totalTokens === "number") return r.totalTokens;
  const nodes = r.nodeResults ?? r.nodes ?? [];
  return nodes.reduce((s, n) => s + (n.tokens ?? n.tokensUsed ?? 0), 0);
}

function shortGoal(s: string | undefined, max = 48): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return v.slice(0, max - 1) + "…";
}

function shortId(s: string, max = 24): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Render a flat table of runs, newest-first by `startedAt`. Limited to
 * `limit` rows; if fewer records exist, all are shown.
 */
export function renderList(records: PersistedRecord[], limit: number): string {
  // Sort by startedAt DESC. Records missing startedAt sort last (empty string
  // < any ISO timestamp).
  const sorted = [...records].sort((a, b) => {
    const ax = a.result.startedAt ?? "";
    const bx = b.result.startedAt ?? "";
    if (ax < bx) return 1;
    if (ax > bx) return -1;
    return 0;
  });
  const rows = sorted.slice(0, Math.max(0, limit));
  const lines: string[] = [];
  lines.push(
    `${pad("graph-id", 24)}  ${pad("ok", 6)}  ${pad("startedAt", 22)}  ${pad("tokens", 8)}  goal`,
  );
  lines.push(
    `${"-".repeat(24)}  ${"-".repeat(6)}  ${"-".repeat(22)}  ${"-".repeat(8)}  ${"-".repeat(24)}`,
  );
  for (const rec of rows) {
    const id = shortId(rec.graph.id ?? rec.result.graphId ?? "?", 24);
    const ok = rec.result.ok ? "ok" : "fail";
    const started = (rec.result.startedAt ?? "").slice(0, 22);
    const tokens = String(totalTokensOf(rec));
    const goal = shortGoal(rec.graph.goal, 48);
    lines.push(
      `${pad(id, 24)}  ${pad(ok, 6)}  ${pad(started, 22)}  ${pad(tokens, 8)}  ${goal}`,
    );
  }
  lines.push(
    `\n${rows.length} of ${records.length} run${records.length === 1 ? "" : "s"} shown`,
  );
  return lines.join("\n") + "\n";
}

/**
 * Render a detail view (tree-style) of a single run: graph metadata then
 * per-node line entries.
 */
export function renderDetail(rec: PersistedRecord): string {
  const g = rec.graph;
  const r = rec.result;
  const nodes = r.nodeResults ?? r.nodes ?? [];
  const lines: string[] = [];
  lines.push(`Run ${g.id}`);
  lines.push(`  goal:       ${shortGoal(g.goal, 80)}`);
  lines.push(`  tier:       ${g.tier ?? "?"}`);
  lines.push(`  ok:         ${r.ok}`);
  lines.push(`  startedAt:  ${r.startedAt ?? "?"}`);
  if (r.finishedAt) lines.push(`  finishedAt: ${r.finishedAt}`);
  if (typeof r.totalDurationMs === "number") lines.push(`  duration:   ${r.totalDurationMs}ms`);
  lines.push(`  tokens:     ${totalTokensOf(rec)}`);
  if (r.error) lines.push(`  error:      ${r.error}`);
  lines.push(`  nodes:`);
  if (nodes.length === 0) {
    lines.push(`    (none)`);
  } else {
    // Build a quick lookup so we can show agentKind alongside each result.
    const kindById = new Map<string, string>();
    for (const gn of g.nodes ?? []) kindById.set(gn.id, gn.agentKind ?? "?");
    const last = nodes.length - 1;
    nodes.forEach((n, i) => {
      const branch = i === last ? "└─" : "├─";
      const tag = n.ok ? "[ok]  " : "[fail]";
      const kind = kindById.get(n.id) ?? "?";
      const dur = `${n.durationMs}ms`;
      const tokens = `${n.tokens ?? n.tokensUsed ?? 0} tokens`;
      lines.push(`    ${branch} ${tag} ${pad(n.id, 18)} (${kind}, ${dur}, ${tokens})`);
      if (n.error) lines.push(`        error: ${n.error}`);
    });
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main entry — dependency-injected for tests.
// ---------------------------------------------------------------------------

export interface MainDeps {
  argv: string[];
  home?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function main(deps: MainDeps): Promise<number> {
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const home = (deps.home ?? homedir)();
  const args = parseArgs(deps.argv);
  const dir = orchestrationsDir(home);

  // Detail mode (single graph id, no --json or --json with id).
  if (args.graphId) {
    if (!isSafeGraphId(args.graphId)) {
      err(`Invalid graph id ${JSON.stringify(args.graphId)} — must be alphanumeric + hyphen/underscore.\n`);
      return 1;
    }
    const rec = loadRecord(home, args.graphId, { warn: err });
    if (!rec) {
      err(`No run found with id ${args.graphId}\n`);
      return 1;
    }
    if (args.json) {
      out(JSON.stringify(rec, null, 2) + "\n");
    } else {
      out(renderDetail(rec));
    }
    return 0;
  }

  // List mode — also handles `--json` (with no id).
  if (!existsSync(dir)) {
    if (args.json) {
      out(JSON.stringify([], null, 2) + "\n");
      return 0;
    }
    out("No orchestration runs yet — use /ashlr-orchestrate to start.\n");
    return 0;
  }

  const records = loadAllRecords(home, { warn: err });
  if (records.length === 0) {
    if (args.json) {
      out(JSON.stringify([], null, 2) + "\n");
      return 0;
    }
    out("No orchestration runs yet — use /ashlr-orchestrate to start.\n");
    return 0;
  }

  // Sort newest-first for both renderers + JSON.
  const sorted = [...records].sort((a, b) => {
    const ax = a.result.startedAt ?? "";
    const bx = b.result.startedAt ?? "";
    if (ax < bx) return 1;
    if (ax > bx) return -1;
    return 0;
  });

  if (args.json) {
    out(JSON.stringify(sorted.slice(0, args.last), null, 2) + "\n");
    return 0;
  }

  out(renderList(records, args.last));
  return 0;
}

// ---------------------------------------------------------------------------
// Direct invocation guard
// ---------------------------------------------------------------------------

const isDirectInvocation =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (typeof process !== "undefined" && process.argv[1]?.endsWith("cli-orchestrate-status.ts"));

if (isDirectInvocation) {
  // Reference statSync so it's not tree-shaken in case future logic needs it.
  void statSync;
  main({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(2);
    });
}
