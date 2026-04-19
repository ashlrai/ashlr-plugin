/**
 * ls-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__ls tool into the shared registry
 * (_tool-base.ts). Used by both the standalone entry point (ls-server.ts)
 * and the router (_router.ts via _router-handlers.ts).
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { recordSaving as recordSavingCore } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

function listDir(rootAbs: string): Entry[] | { error: string } {
  let names: string[];
  if (!existsSync(rootAbs)) return { error: `No such path: ${rootAbs}` };
  try {
    const st = statSync(rootAbs);
    if (!st.isDirectory()) return { error: `Not a directory: ${rootAbs}` };
  } catch (err) {
    return { error: `Cannot stat ${rootAbs}: ${String(err)}` };
  }

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
    collectTopLevel(["ls-files"]);
    collectTopLevel(["ls-files", "--others", "--exclude-standard"]);
    if (set.size > 0) {
      names = Array.from(set);
    } else {
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
      // Broken symlink / permission denied — skip.
    }
  }
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

export async function handleLs(args: LsOptions): Promise<string> {
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

  const baseline = result.reduce((acc, e) => acc + e.name.length + 12, 0);
  await recordSavingCore(baseline, rendered.length, "ashlr__ls");

  const header = `${rootAbs}  ·  ${total} entries${elided ? ` (${max} shown)` : ""}`;
  return `${header}\n${rendered}`;
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
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
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await handleLs(args as unknown as LsOptions);
    return { content: [{ type: "text", text }] };
  },
});
