/**
 * glob-server-handlers — side-effect module.
 *
 * Importing this file registers the ashlr__glob tool into the shared registry
 * (_tool-base.ts). Used by both the standalone entry point (glob-server.ts)
 * and the router (_router.ts via _router-handlers.ts).
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { readdirSync, lstatSync } from "fs";
import { join, relative } from "path";
import { spawnSync } from "child_process";
import { Glob } from "bun";
import { recordSaving as recordSavingCore } from "./_stats";
import { clampToCwd } from "./_cwd-clamp";
import { summarizeIfLarge, PROMPTS } from "./_summarize";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDES = new Set([
  "node_modules", "dist", "build", ".git", ".next",
  ".cache", ".turbo", "__pycache__", ".venv", ".DS_Store",
]);

const TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 200;

interface GlobOptions {
  pattern: string;
  cwd?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

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
  const res = spawnSync(
    "git",
    ["-C", abs, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "buffer", timeout: 5000, maxBuffer: 50 * 1024 * 1024 },
  );
  if (res.status !== 0) return null;
  return res.stdout
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fallback fs walk
// ---------------------------------------------------------------------------

function walkFs(root: string, deadline: number): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    if (Date.now() > deadline) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.has(entry)) continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile()) {
        results.push(relative(root, abs));
      }
    }
  };
  visit(root);
  return results;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchPaths(pattern: string, paths: string[]): string[] {
  const glob = new Glob(pattern);
  return paths.filter((p) => glob.match(p));
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatOutput(matches: string[], pattern: string, limit: number): string {
  const n = matches.length;

  if (n === 0) {
    return `[ashlr__glob] pattern "${pattern}" · 0 matches · 0 dirs · limit=${limit}`;
  }

  const lines: string[] = [];

  if (n <= 20) {
    lines.push(...matches);
  } else {
    const groups = new Map<string, string[]>();
    for (const m of matches) {
      const slash = m.indexOf("/");
      const top = slash === -1 ? "." : m.slice(0, slash);
      const arr = groups.get(top) ?? [];
      arr.push(m);
      groups.set(top, arr);
    }

    for (const [dir, files] of groups) {
      const count = files.length;
      const first5 = files.slice(0, 5);
      const last2 = files.slice(-2);

      if (count <= 7) {
        lines.push(`${dir}/ · ${count} files (${files.join(", ")})`);
      } else {
        const shown = [...new Set([...first5, ...last2])];
        lines.push(`${dir}/ · ${count} files (${shown.slice(0, 5).join(", ")}, …, ${shown.slice(-2).join(", ")})`);
      }
    }
  }

  const dirs = new Set(
    matches.map((m) => {
      const slash = m.indexOf("/");
      return slash === -1 ? "." : m.slice(0, slash);
    }),
  ).size;

  lines.push(`[ashlr__glob] pattern "${pattern}" · ${n} matches · ${dirs} dirs · limit=${limit}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

export async function ashlrGlob(input: GlobOptions): Promise<string> {
  const clamp = clampToCwd(input.cwd, "ashlr__glob");
  if (!clamp.ok) return clamp.message;
  const cwd = clamp.abs;
  const limit = typeof input.limit === "number" ? input.limit : DEFAULT_LIMIT;
  const { pattern } = input;

  const deadline = Date.now() + TIMEOUT_MS;

  let candidates: string[];
  if (isGitRepo(cwd)) {
    candidates = listGitFiles(cwd) ?? walkFs(cwd, deadline);
  } else {
    candidates = walkFs(cwd, deadline);
  }

  let matches = matchPaths(pattern, candidates);
  matches = matches.slice(0, limit);

  const rawBaseline = matches.join("\n").length;
  const output = formatOutput(matches, pattern, limit);

  // For very large listings, route through LLM summarization.
  const GLOB_LLM_THRESHOLD = 8 * 1024; // 8 KB
  if (Buffer.byteLength(output, "utf-8") > GLOB_LLM_THRESHOLD) {
    const result = await summarizeIfLarge(output, {
      toolName: "ashlr__glob",
      systemPrompt: PROMPTS.glob,
      thresholdBytes: GLOB_LLM_THRESHOLD,
    });
    await recordSavingCore(rawBaseline, result.outputBytes, "ashlr__glob");
    return result.text;
  }

  await recordSavingCore(rawBaseline, output.length, "ashlr__glob");
  return output;
}

// ---------------------------------------------------------------------------
// Registration (side-effect on import)
// ---------------------------------------------------------------------------

registerTool({
  name: "ashlr__glob",
  description:
    "Token-efficient glob pattern matching. Returns compressed output instead of raw file lists: ≤20 matches listed verbatim; >20 matches grouped by top-level directory with counts and sample paths. Honors .gitignore automatically inside git repos (uses `git ls-files`), otherwise walks the filesystem while skipping node_modules, dist, build, .git, .next, .cache, .turbo, __pycache__, .venv. Replaces the native Glob tool — produces 70-90% fewer tokens on large repos.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts')",
      },
      cwd: {
        type: "string",
        description: "Directory to search in (default: cwd)",
      },
      limit: {
        type: "number",
        description: `Max matches to return (default: ${DEFAULT_LIMIT})`,
      },
    },
    required: ["pattern"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const text = await ashlrGlob(args as unknown as GlobOptions);
    return { content: [{ type: "text", text }] };
  },
});
