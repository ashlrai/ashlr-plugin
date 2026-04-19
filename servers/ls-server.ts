#!/usr/bin/env bun
/**
 * ashlr-ls MCP server.
 *
 * Exposes a single tool:
 *   - ashlr__ls — gitignore-aware directory listing in a compact columnar view.
 *     Elides past a configurable entry cap. Returns file sizes inline when
 *     requested.
 *
 * Why wrap `ls`? Native `ls` floods context on large directories (node_modules
 * listings, build artefacts, etc.) because it emits one line per entry with
 * no filtering or elision. This wrapper honours `.gitignore` when in a git
 * repo, caps output past `maxEntries`, and emits an elision marker so Claude
 * knows results were truncated and can opt into `bypassSummary: true`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { recordSaving as recordSavingCore } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

async function recordSaving(baselineChars: number, compactChars: number): Promise<void> {
  await recordSavingCore(baselineChars, compactChars, "ashlr__ls");
}

interface LsOptions {
  path?: string;
  maxEntries?: number;
  sizes?: boolean;
  bypassSummary?: boolean;
}

interface Entry {
  name: string;
  dir: boolean;
  size: number;
}

const DEFAULT_MAX = 80;

function listDir(rootAbs: string): Entry[] | { error: string } {
  let names: string[];
  if (!existsSync(rootAbs)) return { error: `No such path: ${rootAbs}` };
  try {
    const st = statSync(rootAbs);
    if (!st.isDirectory()) return { error: `Not a directory: ${rootAbs}` };
  } catch (err) {
    return { error: `Cannot stat ${rootAbs}: ${String(err)}` };
  }

  // Honour .gitignore when we're in a git repo. We combine two git calls so
  // the listing contains both tracked files AND untracked-but-not-ignored
  // files — ls-tree alone would silently hide unstaged work, which is the
  // exact scenario where a user is actively adding files and wants to see
  // them. Falls through to a plain readdir when we're not in a repo.
  const git = spawnSync("git", ["-C", rootAbs, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
  });
  if (git.status === 0 && git.stdout.trim() === "true") {
    const set = new Set<string>();
    const collectTopLevel = (args: string[]): void => {
      const result = spawnSync("git", ["-C", rootAbs, ...args], { encoding: "utf-8" });
      if (result.status !== 0) return;
      for (const line of result.stdout.split("\n")) {
        const first = line.split("/")[0];
        if (first) set.add(first);
      }
    };
    // Tracked + cached: git ls-files gives us the index + HEAD union.
    collectTopLevel(["ls-files"]);
    // Untracked-but-not-ignored: respects .gitignore via --exclude-standard.
    collectTopLevel(["ls-files", "--others", "--exclude-standard"]);
    if (set.size > 0) {
      names = Array.from(set);
    } else {
      // Empty repo with no HEAD / no tracked files / no untracked files.
      // Fall through to readdir so the directory still lists something.
      try { names = readdirSync(rootAbs); } catch (err) {
        return { error: `readdir failed: ${String(err)}` };
      }
    }
  } else {
    try { names = readdirSync(rootAbs); } catch (err) {
      return { error: `readdir failed: ${String(err)}` };
    }
  }

  const entries: Entry[] = [];
  for (const name of names) {
    if (name === ".DS_Store") continue;
    try {
      const st = statSync(resolve(rootAbs, name));
      entries.push({ name, dir: st.isDirectory(), size: st.size });
    } catch {
      // Broken symlink / permission denied — skip without failing.
    }
  }
  // Directories first, then files, both alphabetical.
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

function renderEntries(entries: Entry[], sizes: boolean, maxEntries: number, elided = 0): string {
  const shown = entries.slice(0, maxEntries);
  const lines: string[] = [];
  for (const e of shown) {
    const name = e.dir ? `${e.name}/` : e.name;
    if (sizes && !e.dir) {
      lines.push(`${formatSize(e.size).padStart(7)}  ${name}`);
    } else if (sizes) {
      lines.push(`${"—".padStart(7)}  ${name}`);
    } else {
      lines.push(name);
    }
  }
  if (elided > 0) {
    lines.push(`[… ${elided} entries elided — pass bypassSummary:true to see the full list]`);
  }
  return lines.join("\n");
}

async function handleLs(args: LsOptions): Promise<string> {
  const maxEntries = Math.max(1, Math.min(1000, args.maxEntries ?? DEFAULT_MAX));
  const sizes = args.sizes === true;
  const bypass = args.bypassSummary === true;

  const clamp = clampToCwd(args.path, "ashlr__ls");
  if (!clamp.ok) return clamp.message;
  const rootAbs = clamp.abs;

  const result = listDir(rootAbs);
  if ("error" in result) return result.error;

  const total = result.length;
  const max = bypass ? total : maxEntries;
  const elided = Math.max(0, total - max);
  const rendered = renderEntries(result, sizes, max, elided);

  // Baseline approximation: one full-width line per entry without elision.
  const baseline = result.reduce((acc, e) => acc + e.name.length + 12, 0);
  await recordSaving(baseline, rendered.length);

  const header = `${rootAbs}  ·  ${total} entries${elided ? ` (${max} shown)` : ""}`;
  return `${header}\n${rendered}`;
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-ls", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__ls",
      description:
        "Gitignore-aware directory listing. Compact columnar output with elision past maxEntries (default 80). Set bypassSummary:true to see all entries.",
      inputSchema: {
        type: "object",
        properties: {
          path:          { type: "string",  description: "Directory to list (absolute or cwd-relative). Default '.'" },
          maxEntries:    { type: "number",  description: "Cap on entries shown (default 80, max 1000)" },
          sizes:         { type: "boolean", description: "Include human-readable file sizes" },
          bypassSummary: { type: "boolean", description: "Return every entry without elision" },
        },
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ashlr__ls") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const text = await handleLs((req.params.arguments ?? {}) as LsOptions);
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
