#!/usr/bin/env bun
/**
 * ashlr-tree MCP server.
 *
 * Exposes a single tool:
 *   - ashlr__tree — token-efficient project structure view (Unicode box-drawing
 *     tree) in a single call. Uses `git ls-files` when inside a git repo so
 *     .gitignore is honored for free; falls back to readdir with a hardcoded
 *     exclusion set otherwise.
 *
 * Token savings are recorded to the same ~/.ashlr/stats.json file the
 * efficiency server writes.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readdirSync, statSync, lstatSync, readFileSync } from "fs";
import { join, sep, basename } from "path";
import { spawnSync } from "child_process";
import { recordSaving as recordSavingCore } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

async function recordSaving(baselineChars: number, compactChars: number): Promise<void> {
  await recordSavingCore(baselineChars, compactChars, "ashlr__tree");
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDES = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  ".DS_Store",
];

const FILE_SCAN_CAP = 5_000;
const TIMEOUT_MS = 15_000;
const DIR_TRUNC_THRESHOLD = 10; // entries per dir before we elide

interface TreeOptions {
  path?: string;
  depth?: number;
  pattern?: string;
  exclude?: string[];
  sizes?: boolean;
  loc?: boolean;
  maxEntries?: number;
}

interface Node {
  name: string;
  abs: string;
  isDir: boolean;
  size: number; // bytes; for dirs, aggregate of descendants
  loc?: number; // only for files when loc:true
  children?: Node[];
  fileCount?: number; // for dirs, recursive file count
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function isGitRepo(abs: string): boolean {
  try {
    const res = spawnSync("git", ["-C", abs, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    return res.status === 0 && (res.stdout || "").trim() === "true";
  } catch {
    return false;
  }
}

function listGitFiles(abs: string): string[] | null {
  const res = spawnSync("git", ["-C", abs, "ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf-8",
    timeout: 5000,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  return (res.stdout || "").split("\n").filter(Boolean);
}

function isProbablyText(buf: Buffer): boolean {
  // Heuristic: no NUL byte in first 4KB and mostly printable.
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function countLoc(absFile: string): number | undefined {
  try {
    const buf = readFileSync(absFile);
    if (!isProbablyText(buf)) return undefined;
    const text = buf.toString("utf-8");
    if (!text) return 0;
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    // if the file ends with \n, last newline shouldn't double-count
    if (text.endsWith("\n")) n--;
    return Math.max(0, n);
  } catch {
    return undefined;
  }
}

interface BuildContext {
  root: string;
  excludes: Set<string>;
  pattern?: RegExp;
  maxDepth: number;
  loc: boolean;
  started: number;
  scanned: { count: number };
  truncatedScan: boolean;
  timedOut: boolean;
}

function walkFs(ctx: BuildContext, abs: string, depth: number): Node | null {
  if (Date.now() - ctx.started > TIMEOUT_MS) {
    ctx.timedOut = true;
    return null;
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    // Follow only if target is inside root.
    try {
      const real = statSync(abs);
      const realPath = require("fs").realpathSync(abs);
      if (!realPath.startsWith(ctx.root + sep) && realPath !== ctx.root) return null;
      st = real;
    } catch {
      return null;
    }
  }
  const name = basename(abs);
  if (!st.isDirectory()) {
    if (ctx.scanned.count >= FILE_SCAN_CAP) {
      ctx.truncatedScan = true;
      return null;
    }
    ctx.scanned.count++;
    if (ctx.pattern && !ctx.pattern.test(abs)) return null;
    const node: Node = { name, abs, isDir: false, size: st.size };
    if (ctx.loc) node.loc = countLoc(abs);
    return node;
  }
  // Directory
  if (depth > ctx.maxDepth) {
    // Still count aggregate? Keep it cheap: stop here.
    return { name, abs, isDir: true, size: 0, children: [], fileCount: 0 };
  }
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return null;
  }
  const children: Node[] = [];
  let aggSize = 0;
  let fileCount = 0;
  for (const entry of entries) {
    if (ctx.excludes.has(entry)) continue;
    if (ctx.timedOut || ctx.truncatedScan) break;
    const childAbs = join(abs, entry);
    const child = walkFs(ctx, childAbs, depth + 1);
    if (!child) continue;
    children.push(child);
    aggSize += child.size;
    fileCount += child.isDir ? (child.fileCount ?? 0) : 1;
  }
  return { name, abs, isDir: true, size: aggSize, children, fileCount };
}

function buildFromGitFiles(
  root: string,
  files: string[],
  ctx: BuildContext,
): Node {
  const rootNode: Node = { name: basename(root), abs: root, isDir: true, size: 0, children: [], fileCount: 0 };
  const dirCache = new Map<string, Node>();
  dirCache.set("", rootNode);

  const getDir = (relDir: string): Node => {
    if (dirCache.has(relDir)) return dirCache.get(relDir)!;
    const parts = relDir.split("/");
    const parentRel = parts.slice(0, -1).join("/");
    const parent = getDir(parentRel);
    const abs = join(root, relDir);
    const node: Node = { name: parts[parts.length - 1]!, abs, isDir: true, size: 0, children: [], fileCount: 0 };
    parent.children!.push(node);
    dirCache.set(relDir, node);
    return node;
  };

  for (const rel of files) {
    if (ctx.scanned.count >= FILE_SCAN_CAP) {
      ctx.truncatedScan = true;
      break;
    }
    if (Date.now() - ctx.started > TIMEOUT_MS) {
      ctx.timedOut = true;
      break;
    }
    // depth check: number of sep-separated components
    const parts = rel.split("/");
    if (parts.length - 1 > ctx.maxDepth) continue; // depth 0 = root files

    const abs = join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        const realPath = require("fs").realpathSync(abs);
        if (!realPath.startsWith(root + sep) && realPath !== root) continue;
        st = statSync(abs);
      } catch {
        continue;
      }
    }
    if (!st.isFile()) continue;
    if (ctx.pattern && !ctx.pattern.test(abs)) continue;

    ctx.scanned.count++;
    const parentRel = parts.slice(0, -1).join("/");
    const parent = getDir(parentRel);
    const node: Node = { name: parts[parts.length - 1]!, abs, isDir: false, size: st.size };
    if (ctx.loc) node.loc = countLoc(abs);
    parent.children!.push(node);
  }

  // Post-order aggregate sizes / counts.
  const agg = (n: Node): void => {
    if (!n.isDir) return;
    let size = 0;
    let files = 0;
    for (const c of n.children ?? []) {
      agg(c);
      size += c.size;
      files += c.isDir ? (c.fileCount ?? 0) : 1;
    }
    n.size = size;
    n.fileCount = files;
  };
  agg(rootNode);
  return rootNode;
}

function sortChildren(n: Node): void {
  if (!n.isDir || !n.children) return;
  n.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.isDir) return a.name.localeCompare(b.name);
    // files: size desc, then name
    if (a.size !== b.size) return b.size - a.size;
    return a.name.localeCompare(b.name);
  });
  for (const c of n.children) sortChildren(c);
}

interface RenderContext {
  budget: { left: number; total: number };
  sizes: boolean;
  loc: boolean;
  truncatedByBudget: boolean;
}

function formatMeta(n: Node, rctx: RenderContext): string {
  const parts: string[] = [];
  if (rctx.sizes) parts.push(formatSize(n.size));
  if (n.isDir && (n.fileCount ?? 0) > 0) parts.push(`${n.fileCount} files`);
  if (!n.isDir && rctx.loc && typeof n.loc === "number") parts.push(`${n.loc} LOC`);
  return parts.length ? "  " + parts.join(" \u00b7 ") : "";
}

function renderTree(root: Node, rctx: RenderContext): string {
  const lines: string[] = [];
  const header = `${root.name}/${formatMeta(root, rctx)}`;
  lines.push(header);

  const walk = (node: Node, prefix: string): void => {
    if (rctx.budget.left <= 0) {
      rctx.truncatedByBudget = true;
      return;
    }
    const kids = node.children ?? [];
    // Decide how many to show
    let shown: Node[];
    let elided = 0;
    if (kids.length > DIR_TRUNC_THRESHOLD && kids.length > rctx.budget.left) {
      const first = kids.slice(0, 5);
      const last = kids.slice(-2);
      elided = kids.length - first.length - last.length;
      shown = [...first, ...last];
    } else if (kids.length > DIR_TRUNC_THRESHOLD) {
      // Use budget if available; otherwise truncate.
      // Simple rule: if we have plenty of budget, show all; else elide.
      if (rctx.budget.left >= kids.length) {
        shown = kids;
      } else {
        const first = kids.slice(0, 5);
        const last = kids.slice(-2);
        elided = kids.length - first.length - last.length;
        shown = [...first, ...last];
      }
    } else {
      shown = kids;
    }

    const lastShownIdx = shown.length - 1 + (elided > 0 ? 1 : 0);
    const total = shown.length + (elided > 0 ? 1 : 0);

    for (let i = 0; i < shown.length; i++) {
      if (rctx.budget.left <= 0) {
        rctx.truncatedByBudget = true;
        return;
      }
      const child = shown[i]!;
      const isLast = i === total - 1;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
      const namePart = child.isDir ? `${child.name}/` : child.name;
      lines.push(`${prefix}${connector}${namePart}${formatMeta(child, rctx)}`);
      rctx.budget.left--;
      if (child.isDir) {
        const nextPrefix = prefix + (isLast ? "    " : "\u2502   ");
        walk(child, nextPrefix);
      }
      // Insert the elision marker between the first-5 and last-2 groups.
      if (elided > 0 && i === 4) {
        const connector2 = "\u251c\u2500\u2500 ";
        lines.push(`${prefix}${connector2}[... ${elided} more ...]`);
        // Don't consume budget for the marker.
      }
    }

    void lastShownIdx;
  };

  walk(root, "");
  return lines.join("\n");
}

function countFilesAndDirs(n: Node): { dirs: number; files: number } {
  let dirs = 0;
  let files = 0;
  const visit = (x: Node): void => {
    if (x.isDir) {
      dirs++;
      for (const c of x.children ?? []) visit(c);
    } else {
      files++;
    }
  };
  visit(n);
  // Don't count root as a dir in the summary; mirror the example format.
  return { dirs: Math.max(0, dirs - 1), files };
}

// Baseline: roughly what `find . -type f | xargs wc -l` would emit — one line
// per file of the form "<LOC>\t<path>\n". We approximate by summing
// (path + ~8 char LOC column + 2 sep chars) across all files.
function baselineBytes(n: Node): number {
  let bytes = 0;
  const visit = (x: Node, prefix: string): void => {
    const rel = prefix ? `${prefix}/${x.name}` : x.name;
    if (x.isDir) {
      for (const c of x.children ?? []) visit(c, rel);
    } else {
      bytes += rel.length + 10; // path + tab + ~8-digit count + newline
    }
  };
  visit(n, "");
  return bytes;
}

export async function ashlrTree(input: TreeOptions): Promise<string> {
  const clamp = clampToCwd(input.path, "ashlr__tree");
  if (!clamp.ok) return clamp.message;
  const rootAbs = clamp.abs;
  if (!existsSync(rootAbs)) {
    throw new Error(`path does not exist: ${rootAbs}`);
  }
  const st = statSync(rootAbs);
  if (!st.isDirectory()) {
    throw new Error(`path is not a directory: ${rootAbs}`);
  }

  const maxDepth = typeof input.depth === "number" ? input.depth : 4;
  const excludes = new Set(input.exclude ?? DEFAULT_EXCLUDES);
  const sizes = input.sizes ?? true;
  const loc = input.loc ?? false;
  const maxEntries = typeof input.maxEntries === "number" ? input.maxEntries : 500;
  let pattern: RegExp | undefined;
  if (input.pattern) {
    try {
      pattern = new RegExp(input.pattern);
    } catch (e) {
      throw new Error(`invalid pattern regex: ${(e as Error).message}`);
    }
  }

  const ctx: BuildContext = {
    root: rootAbs,
    excludes,
    pattern,
    maxDepth,
    loc,
    started: Date.now(),
    scanned: { count: 0 },
    truncatedScan: false,
    timedOut: false,
  };

  let rootNode: Node | null = null;
  const gitFiles = isGitRepo(rootAbs) ? listGitFiles(rootAbs) : null;
  if (gitFiles) {
    rootNode = buildFromGitFiles(rootAbs, gitFiles, ctx);
  } else {
    rootNode = walkFs(ctx, rootAbs, 0);
  }

  if (!rootNode) {
    return `[ashlr__tree] failed to scan ${rootAbs}`;
  }

  sortChildren(rootNode);

  const { dirs, files } = countFilesAndDirs(rootNode);
  if (files === 0 && (rootNode.children?.length ?? 0) === 0) {
    return `${rootNode.name}/  [empty]`;
  }

  const rctx: RenderContext = {
    budget: { left: maxEntries, total: maxEntries },
    sizes,
    loc,
    truncatedByBudget: false,
  };
  const body = renderTree(rootNode, rctx);

  const summary = `${dirs} dirs \u00b7 ${files} files \u00b7 ${formatSize(rootNode.size)} total`;
  const flags: string[] = [];
  if (ctx.timedOut) flags.push("[... timed out ...]");
  if (ctx.truncatedScan) flags.push("truncated: true (file scan cap hit)");
  if (rctx.truncatedByBudget) flags.push("truncated: true (maxEntries reached)");

  const out = [body, "", summary, ...flags].filter(Boolean).join("\n");

  // Record savings: baseline ~= find+wc -l output; compact = our rendered bytes.
  const baseline = baselineBytes(rootNode);
  await recordSaving(baseline, out.length);
  return out;
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-tree", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__tree",
      description:
        "Token-efficient project structure view. One call returns a Unicode box-drawing tree with per-directory size/file-count and optional per-file LOC. Honors .gitignore automatically inside git repos, otherwise skips a standard exclusion set (node_modules, dist, build, .git, .next, .cache, .turbo, __pycache__, .venv). Replaces the 3-5 orientation calls (ls -la + find + multiple Reads) Claude Code normally makes when opening a repo.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to scan (default: cwd)" },
          depth: { type: "number", description: "Max traversal depth (default: 4)" },
          pattern: { type: "string", description: "Only include files matching this regex (e.g. '\\\\.ts$')" },
          exclude: {
            type: "array",
            items: { type: "string" },
            description:
              "Directory names to skip (default: node_modules, dist, build, .git, .next, .cache, .turbo, __pycache__, .venv, .DS_Store)",
          },
          sizes: { type: "boolean", description: "Include file sizes shown as B/KB/MB (default: true)" },
          loc: {
            type: "boolean",
            description:
              "Include line counts for text files (default: false; more expensive — reads every file)",
          },
          maxEntries: {
            type: "number",
            description: "Hard cap on entries returned (default: 500). When exceeded, per-dir truncation with count.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "ashlr__tree": {
        const text = await ashlrTree((args ?? {}) as TreeOptions);
        return { content: [{ type: "text", text }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
  }
});

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// unused relative import guard

