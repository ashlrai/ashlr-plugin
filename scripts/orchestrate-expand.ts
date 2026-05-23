#!/usr/bin/env bun
/**
 * orchestrate-expand — Q1 2027 Distributed Orchestration: auto-expander.
 *
 * Given a goal + scope, deterministically generate a TaskGraph by:
 *   1. Discovering "modules" at the scope root (direct child directories,
 *      optionally fronted by a `src/` layout that we descend through once).
 *   2. Bucketing source files per module + classifying each module by content
 *      (tests, docs, or general source → refactorer).
 *   3. Tracing first-party imports between modules via the regex extractor
 *      borrowed from servers/_prefetch.ts and turning those into `deps`.
 *   4. Ranking modules by file-count + goal-keyword relevance and capping at
 *      `maxNodes` (default: 3 for pro, 10 for team).
 *   5. Sizing each node's `estimatedTokens` (≈2000 base + 50/file, capped at
 *      20000).
 *
 * No LLM calls. Pure + deterministic for the same inputs. The runner (Track B)
 * and slash command (Track C) consume the output verbatim.
 *
 * CLI:
 *   bun scripts/orchestrate-expand.ts \
 *     --goal "Add freshness logging" \
 *     --scope servers/ \
 *     --tier pro [--yaml] [--max-nodes 5]
 */

import { readdirSync, lstatSync, statSync, existsSync, readFileSync } from "fs";
import { join, relative, resolve, basename, dirname, isAbsolute, sep } from "path";
import { randomUUID } from "crypto";

import {
  toYaml,
  validateTaskGraph,
  type AgentKind,
  type TaskGraph,
  type TaskNode,
} from "../servers/_task-graph.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExpandOptions {
  goal: string;
  scope: string;           // cwd-relative or absolute directory
  tier: "pro" | "team";
  maxNodes?: number;       // default 3 for pro, 10 for team
  cwd?: string;
}

const DEFAULT_PRO_CAP = 3;
const DEFAULT_TEAM_CAP = 10;

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);
const TOKENISH_EXTS = new Set([".ts", ".tsx", ".py", ".go"]); // used for token estimation per spec
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  ".ashlrcode",
  "coverage",
  ".vscode",
  ".idea",
  ".in_use",
]);

const TOKENS_BASE = 2000;
const TOKENS_PER_FILE = 50;
const TOKENS_CAP = 20000;

/** Auto-expand a goal+scope into a TaskGraph. Deterministic for the same inputs. */
export async function expandToTaskGraph(opts: ExpandOptions): Promise<TaskGraph> {
  const cwd = opts.cwd ?? process.cwd();
  const scopeAbs = isAbsolute(opts.scope) ? opts.scope : resolve(cwd, opts.scope);
  if (!existsSync(scopeAbs) || !statSync(scopeAbs).isDirectory()) {
    throw new Error(`scope is not a directory: ${scopeAbs}`);
  }

  const cap = opts.maxNodes ?? (opts.tier === "team" ? DEFAULT_TEAM_CAP : DEFAULT_PRO_CAP);
  const modules = discoverModules(scopeAbs);

  // Score modules: file count + relevance to goal keywords.
  const keywords = extractKeywords(opts.goal);
  type Scored = { module: ModuleInfo; score: number; tokens: number; agentKind: AgentKind };
  const scored: Scored[] = modules.map((m) => {
    const tokenish = m.files.filter((f) => TOKENISH_EXTS.has(ext(f))).length;
    const tokens = Math.min(TOKENS_CAP, TOKENS_BASE + tokenish * TOKENS_PER_FILE);
    const relevance = scoreRelevance(m, keywords);
    return {
      module: m,
      // Files dominate the rank; relevance is a tiebreaker boost.
      score: m.files.length + relevance * 5,
      tokens,
      agentKind: classifyAgent(m),
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.module.name.localeCompare(b.module.name);
  });

  const picked = scored.slice(0, cap);

  // Build a quick lookup from absolute file path → module name (only modules
  // we kept). Imports pointing at files outside this set are ignored.
  const fileToModule = new Map<string, string>();
  for (const s of picked) {
    for (const f of s.module.files) fileToModule.set(f, s.module.name);
  }

  // Build dep edges based on imports.
  const depsByModule = new Map<string, Set<string>>();
  for (const s of picked) depsByModule.set(s.module.name, new Set());

  for (const s of picked) {
    for (const f of s.module.files) {
      if (!shouldScanImports(f)) continue;
      let text: string;
      try {
        text = readFileSync(f, "utf-8");
      } catch {
        continue;
      }
      const imports = extractImports(text);
      for (const spec of imports) {
        const resolved = resolveImport(spec, f, cwd);
        if (!resolved) continue;
        const otherModule = fileToModule.get(resolved);
        if (!otherModule || otherModule === s.module.name) continue;
        depsByModule.get(s.module.name)!.add(otherModule);
      }
    }
  }

  const nodes: TaskNode[] = picked.map((s) => ({
    id: nodeIdFor(s.module.name),
    agentKind: s.agentKind,
    goal: `Apply '${opts.goal}' to module ${s.module.name}`,
    scope: [relative(cwd, s.module.path) || s.module.path],
    deps: Array.from(depsByModule.get(s.module.name) ?? []).map(nodeIdFor).sort(),
    estimatedTokens: s.tokens,
  }));

  // Break any cycles by dropping the dep that closes them. Auto-expansion
  // should never emit a cyclic graph — sibling tracks rely on this guarantee.
  breakCycles(nodes);

  const totalTokenBudget = nodes.reduce((sum, n) => sum + n.estimatedTokens, 0);
  const graph: TaskGraph = {
    id: randomUUID(),
    goal: opts.goal,
    scope: relative(cwd, scopeAbs) || scopeAbs,
    tier: opts.tier,
    createdAt: new Date().toISOString(),
    nodes,
    handoffs: [],
    metadata: { autoExpanded: true, totalTokenBudget },
  };

  // Validate before returning — fast-fail if we ever produce a malformed graph.
  const v = validateTaskGraph(graph);
  if (!v.ok) {
    throw new Error(`expander produced invalid graph: ${v.errors.join("; ")}`);
  }
  return v.graph;
}

// ---------------------------------------------------------------------------
// Module discovery
// ---------------------------------------------------------------------------

interface ModuleInfo {
  name: string;          // e.g. "auth"
  path: string;          // absolute
  files: string[];       // absolute file paths inside the module
}

function discoverModules(scopeAbs: string): ModuleInfo[] {
  // Direct children of the scope dir → candidate modules. We also descend
  // into a single layer of `src/` if it's the only meaningful child.
  let root = scopeAbs;
  const children = safeReaddir(root).filter((c) => !SKIP_DIRS.has(c));
  const dirChildren = children.filter((c) => isDir(join(root, c)));
  // If scope has exactly one source-bearing dir named `src` / `lib`, descend.
  if (dirChildren.length === 1 && (dirChildren[0] === "src" || dirChildren[0] === "lib")) {
    root = join(root, dirChildren[0]!);
  }

  const modules: ModuleInfo[] = [];
  for (const c of safeReaddir(root)) {
    if (SKIP_DIRS.has(c)) continue;
    const childPath = join(root, c);
    if (!isDir(childPath)) continue;
    const files = collectFiles(childPath);
    if (files.length === 0) continue;
    modules.push({ name: c, path: childPath, files });
  }
  return modules;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(d, entry);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile()) {
        const e = ext(abs);
        if (SOURCE_EXTS.has(e) || DOC_EXTS.has(e)) out.push(abs);
      }
    }
  };
  visit(dir);
  return out;
}

function classifyAgent(m: ModuleInfo): AgentKind {
  const testCount = m.files.filter((f) => /\.test\.[tj]sx?$/.test(f) || /_test\.(go|py)$/.test(f)).length;
  const docCount = m.files.filter((f) => DOC_EXTS.has(ext(f))).length;
  const lowerName = m.name.toLowerCase();

  if (testCount > 0 && testCount * 2 >= m.files.length) return "test-writer";
  if (docCount > 0 && docCount * 2 >= m.files.length) return "doc-writer";
  if (lowerName.includes("test") || lowerName.startsWith("__tests__")) return "test-writer";
  if (lowerName === "docs" || lowerName === "documentation") return "doc-writer";
  return "refactorer";
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

function extractKeywords(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "add",
  "make",
  "use",
  "all",
  "any",
  "ref",
  "fix",
  "new",
  "out",
]);

function scoreRelevance(m: ModuleInfo, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lowerName = m.name.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (lowerName.includes(k)) score += 2;
    for (const f of m.files) {
      if (basename(f).toLowerCase().includes(k)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Import extraction (borrowed from servers/_prefetch.ts)
// ---------------------------------------------------------------------------

function extractImports(source: string): string[] {
  const patterns: RegExp[] = [
    /import\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g,
    /from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm,
    /^\s*import\s+([A-Za-z_][\w.]*)/gm,
  ];
  const counts = new Map<string, number>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
    }
  }
  return Array.from(counts.keys());
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"];

function resolveImport(spec: string, fromFile: string, cwd: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
  const candidates: string[] = [base];
  for (const e of RESOLVE_EXTENSIONS) candidates.push(base + e);
  for (const e of RESOLVE_EXTENSIONS) candidates.push(join(base, "index" + e));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      // Bound to the cwd — anything outside is ignored.
      const rel = relative(cwd, candidate);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      return candidate;
    }
  }
  return null;
}

function shouldScanImports(file: string): boolean {
  const e = ext(file);
  return e === ".ts" || e === ".tsx" || e === ".js" || e === ".jsx" || e === ".mjs" || e === ".cjs" || e === ".py";
}

// ---------------------------------------------------------------------------
// Cycle breaker
// ---------------------------------------------------------------------------

function breakCycles(nodes: TaskNode[]): void {
  // Repeatedly find any cycle and drop the LAST edge along it until none
  // remain. Auto-expansion graphs are small (≤10 nodes) so this is cheap.
  while (true) {
    const cycle = findCycleEdges(nodes);
    if (!cycle) return;
    const [from, to] = cycle;
    const node = nodes.find((n) => n.id === from);
    if (!node) return;
    node.deps = node.deps.filter((d) => d !== to);
  }
}

function findCycleEdges(nodes: TaskNode[]): [string, string] | null {
  const byId = new Map<string, TaskNode>();
  for (const n of nodes) byId.set(n.id, n);
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const stack: string[] = [];
  function dfs(id: string): [string, string] | null {
    color.set(id, GREY);
    stack.push(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.deps) {
        const c = color.get(dep);
        if (c === GREY) return [id, dep];
        if (c === WHITE) {
          const found = dfs(dep);
          if (found) return found;
        }
      }
    }
    color.set(id, BLACK);
    stack.pop();
    return null;
  }
  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = dfs(n.id);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function ext(p: string): string {
  const idx = p.lastIndexOf(".");
  return idx === -1 ? "" : p.slice(idx);
}

function nodeIdFor(moduleName: string): string {
  const safe = moduleName.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
  return `node-${safe}`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliArgs {
  goal?: string;
  scope?: string;
  tier?: "pro" | "team";
  maxNodes?: number;
  yaml: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { yaml: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--goal":
        out.goal = argv[++i];
        break;
      case "--scope":
        out.scope = argv[++i];
        break;
      case "--tier": {
        const v = argv[++i];
        if (v === "pro" || v === "team") out.tier = v;
        break;
      }
      case "--max-nodes":
        out.maxNodes = Number(argv[++i]);
        break;
      case "--yaml":
        out.yaml = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: bun scripts/orchestrate-expand.ts --goal <goal> --scope <path> --tier <pro|team> [--max-nodes N] [--yaml]",
      "",
      "  --goal       The user's top-level intent. Required.",
      "  --scope      Directory to expand. Required.",
      "  --tier       'pro' (cap 3) or 'team' (cap 10). Required.",
      "  --max-nodes  Override the tier-default cap.",
      "  --yaml       Emit YAML instead of JSON.",
      "",
    ].join("\n"),
  );
}

// Only run the CLI when this file is executed directly (not when imported by
// tests). `Bun.main` resolves to the script bun started with.
const isDirectRun =
  typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main === import.meta.path;

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.goal || !args.scope || !args.tier) {
    printUsage();
    process.exit(2);
  }
  const opts: ExpandOptions = {
    goal: args.goal,
    scope: args.scope,
    tier: args.tier,
  };
  if (args.maxNodes !== undefined && Number.isFinite(args.maxNodes)) {
    opts.maxNodes = args.maxNodes;
  }
  expandToTaskGraph(opts).then(
    (g) => {
      process.stdout.write(args.yaml ? toYaml(g) : JSON.stringify(g, null, 2) + "\n");
    },
    (err: Error) => {
      process.stderr.write(`orchestrate-expand: ${err.message}\n`);
      process.exit(1);
    },
  );
}
