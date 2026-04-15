#!/usr/bin/env bun
/**
 * ashlr-bash MCP server.
 *
 * Exposes ashlr__bash — a token-efficient replacement for Claude Code's
 * built-in Bash tool. Auto-compresses long stdout, recognizes a handful of
 * common commands and returns compact structured summaries instead of raw
 * output, and refuses catastrophic patterns. stderr is never compressed —
 * errors must reach the agent intact.
 *
 * Persists savings to ~/.ashlr/stats.json using the same schema as the
 * efficiency server so the status line aggregates cleanly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";

// ---------------------------------------------------------------------------
// Savings tracker (shared schema with efficiency server)
// ---------------------------------------------------------------------------

interface Stats {
  session: { calls: number; tokensSaved: number };
  lifetime: { calls: number; tokensSaved: number };
}

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");
const session: Stats["session"] = { calls: 0, tokensSaved: 0 };

async function loadLifetime(): Promise<Stats["lifetime"]> {
  if (!existsSync(STATS_PATH)) return { calls: 0, tokensSaved: 0 };
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf-8")) as Stats;
    return raw.lifetime ?? { calls: 0, tokensSaved: 0 };
  } catch {
    return { calls: 0, tokensSaved: 0 };
  }
}

async function persistStats(lifetime: Stats["lifetime"]): Promise<void> {
  await mkdir(dirname(STATS_PATH), { recursive: true });
  // Preserve any pre-existing session counters from sibling servers when we
  // can — but keeping this server's own session counter as the source of
  // truth is fine because the status line reads lifetime primarily.
  const payload: Stats = { session, lifetime };
  await writeFile(STATS_PATH, JSON.stringify(payload, null, 2));
}

async function recordSaving(rawBytes: number, compactBytes: number): Promise<number> {
  const saved = Math.max(0, Math.ceil((rawBytes - compactBytes) / 4));
  session.calls++;
  session.tokensSaved += saved;
  const lifetime = await loadLifetime();
  lifetime.calls++;
  lifetime.tokensSaved += saved;
  await persistStats(lifetime);
  return saved;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

const COMPRESS_THRESHOLD = 2048;
// Head/tail sizes were tuned for the dominant case: build/test/install logs
// where the failing assertion or stack trace lands in the last few hundred
// bytes, while the head establishes which command/phase produced the output.
// 800 head + 800 tail keeps the structural signal on both ends and still
// fits comfortably under typical 2KB token budgets after framing.
const HEAD_BYTES = 800;
const TAIL_BYTES = 800;

function snipBytes(s: string): { out: string; saved: number } {
  if (s.length <= COMPRESS_THRESHOLD) return { out: s, saved: 0 };
  const elided = s.length - HEAD_BYTES - TAIL_BYTES;
  const out =
    s.slice(0, HEAD_BYTES) +
    `\n[... ${elided.toLocaleString()} bytes of output elided ...]\n` +
    s.slice(-TAIL_BYTES);
  return { out, saved: s.length - out.length };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const DANGEROUS = [
  /\brm\s+-rf?\s+\/(?:\s|$)/,            // rm -rf /
  /\brm\s+-rf?\s+\/\*/,                  // rm -rf /*
  /\brm\s+-rf?\s+~(?:\s|$)/,             // rm -rf ~
  /\brm\s+-rf?\s+\$HOME(?:\s|$)/,        // rm -rf $HOME
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;\s*:/,    // fork bomb
  /\bmkfs(\.\w+)?\b/,                    // mkfs
  /\bdd\s+if=.*of=\/dev\/[sh]d/,         // dd to a raw disk
  />\s*\/dev\/sda/,                      // pipe to raw disk
];

function refusalReason(cmd: string): string | null {
  const trimmed = cmd.trim();
  for (const pat of DANGEROUS) {
    if (pat.test(trimmed)) {
      return `ashlr__bash refused: command matches catastrophic pattern (${pat}). Use Claude Code's built-in Bash if you really intended this.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command-specific summarizers
// ---------------------------------------------------------------------------

interface Summarized {
  text: string;
  rawBytes: number;
  compactBytes: number;
}

function tryCatRefusal(cmd: string): string | null {
  // Detect a leading `cat <file>` (single-file, not a pipe / heredoc / multi-arg).
  const t = cmd.trim();
  if (!/^cat\s+\S/.test(t)) return null;
  if (/[|<>]/.test(t)) return null; // pipe/redirect — leave alone
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;
  // Skip flags except common ones; if all non-flag args are present treat as cat.
  const args = parts.slice(1).filter((a) => !a.startsWith("-"));
  if (args.length === 0) return null;
  return `ashlr__bash refused: use ashlr__read for file contents (path: ${args[0]}). It auto-compresses files > 2KB and tracks savings.`;
}

function summarizeGitStatus(stdout: string, branchHint?: string): string {
  // Works with `git status --porcelain` and `git status --porcelain=v1`.
  // Falls through cleanly for empty output.
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const key = code === "" ? "?" : code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [k, v] of [...counts.entries()].sort()) {
    parts.push(`${k}: ${v}`);
  }
  const branch = branchHint ? ` · branch ${branchHint}` : "";
  return parts.length === 0
    ? `clean${branch}`
    : `${parts.join(", ")}${branch}`;
}

function summarizeLs(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 40) return null;
  const head = lines.slice(0, 20).join("\n");
  const tail = lines.slice(-10).join("\n");
  return `${head}\n[... ${lines.length - 30} more entries elided ...]\n${tail}\n· ${lines.length} entries total`;
}

function summarizeFind(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const head = lines.slice(0, 50).join("\n");
  return `${head}\n[... ${lines.length - 50} more matches elided ...]\n· ${lines.length} matches total`;
}

function summarizePs(stdout: string, cwd: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const cwdName = basename(cwd);
  // Always keep the header (line 0).
  const header = lines[0]!;
  const filtered = lines.slice(1).filter((l) => cwdName && l.includes(cwdName));
  if (filtered.length > 0 && filtered.length < lines.length - 1) {
    return `${header}\n${filtered.join("\n")}\n· filtered ${filtered.length} of ${lines.length - 1} processes by cwd name '${cwdName}'`;
  }
  // No cwd-name match — fall back to head/tail.
  return null;
}

function summarizeNpmLs(stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.length < 50) return null;
  // Dedupe duplicate-version warning lines.
  const seenWarn = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const w = line.match(/(deduped|UNMET|invalid)/);
    if (w) {
      const sig = line.trim();
      if (seenWarn.has(sig)) continue;
      seenWarn.add(sig);
    }
    // Collapse depth > 2 by counting indent (pipes/spaces).
    const depth = (line.match(/[│├└]\s/g) ?? []).length;
    if (depth > 2) continue;
    kept.push(line);
  }
  if (kept.length >= lines.length) return null;
  return `${kept.join("\n")}\n· collapsed depth>2 and deduped warnings (${lines.length} → ${kept.length} lines)`;
}

async function tryStructuredSummary(
  command: string,
  stdout: string,
  cwd: string,
): Promise<string | null> {
  const trimmed = command.trim();

  // git status (porcelain or human) — branch and ahead/behind via separate call.
  if (/^git\s+status(\s|$)/.test(trimmed)) {
    let porcelain = stdout;
    let branchHint: string | undefined;
    if (!/--porcelain/.test(trimmed)) {
      // Re-run a porcelain query to compute counts deterministically.
      try {
        const r = await runRaw("git status --porcelain", cwd, 5000);
        porcelain = r.stdout;
      } catch {
        // Fall back to whatever we have.
      }
    }
    try {
      const b = await runRaw("git rev-parse --abbrev-ref HEAD", cwd, 5000);
      branchHint = b.stdout.trim() || undefined;
    } catch { /* ignore */ }
    let summary = summarizeGitStatus(porcelain, branchHint);
    try {
      const ab = await runRaw("git rev-list --left-right --count @{u}...HEAD", cwd, 5000);
      const m = ab.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) {
        const behind = Number(m[1]);
        const ahead = Number(m[2]);
        if (ahead || behind) summary += ` · ahead ${ahead} behind ${behind}`;
      }
    } catch { /* no upstream — skip */ }
    return summary;
  }

  // ls -la / ls -l
  if (/^ls(\s+-\w+)*(\s|$)/.test(trimmed)) {
    return summarizeLs(stdout);
  }

  // find . -name ...
  if (/^find\s/.test(trimmed)) {
    return summarizeFind(stdout);
  }

  // ps aux / ps -ef
  if (/^ps\s+(aux|-ef)\b/.test(trimmed)) {
    return summarizePs(stdout, cwd);
  }

  // npm ls / bun pm ls
  if (/^(npm\s+ls|bun\s+pm\s+ls)\b/.test(trimmed)) {
    return summarizeNpmLs(stdout);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

function runRaw(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolveP) => {
    const start = Date.now();
    // Use the user's $SHELL when available; fall back to /bin/sh. -c is
    // portable across bash/zsh and preserves quoting/expansion semantics
    // the agent would expect from a normal shell prompt.
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 5 * 1024 * 1024; // 5MB hard cap to avoid OOM on runaway output
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < cap) stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < cap) stderr += b.toString("utf-8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr,
        exitCode: code,
        signal,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        exitCode: 127,
        signal: null,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  compact?: boolean;
}

async function ashlrBash(args: BashArgs): Promise<string> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    return "ashlr__bash error: 'command' is required";
  }
  const cwd = args.cwd ?? process.cwd();
  const timeoutMs = args.timeout_ms ?? 60_000;
  const compact = args.compact !== false;

  const refusal = refusalReason(command);
  if (refusal) return `$ ${command}\n${refusal}`;

  const catMsg = tryCatRefusal(command);
  if (catMsg) return `$ ${command}\n${catMsg}`;

  const res = await runRaw(command, cwd, timeoutMs);

  const exitLabel = res.timedOut
    ? `timed out after ${timeoutMs}ms (killed)`
    : res.signal
      ? `killed by ${res.signal}`
      : `exit ${res.exitCode}`;

  const rawStdoutBytes = res.stdout.length;
  let body: string;
  let compactBytes: number;
  let savedNote = "";

  if (compact) {
    const structured = await tryStructuredSummary(command, res.stdout, cwd);
    if (structured !== null) {
      body = structured;
      compactBytes = body.length;
    } else {
      const { out, saved } = snipBytes(res.stdout);
      body = out;
      compactBytes = out.length;
      if (saved > 0) savedNote = ` · [compact saved ${saved.toLocaleString()} bytes]`;
    }
  } else {
    body = res.stdout;
    compactBytes = res.stdout.length;
  }

  // Track savings for the stdout side only (stderr is not compressed).
  if (compact && rawStdoutBytes > 0) {
    await recordSaving(rawStdoutBytes, compactBytes);
    if (!savedNote && rawStdoutBytes > compactBytes) {
      savedNote = ` · [compact saved ${(rawStdoutBytes - compactBytes).toLocaleString()} bytes]`;
    } else if (!savedNote) {
      savedNote = " · [compact saved 0 bytes]";
    }
  }

  // stderr passes through uncompressed and labeled.
  const stderrBlock = res.stderr.length > 0
    ? `\n--- stderr ---\n${res.stderr}`
    : "";

  const trailer = `· ${exitLabel} · ${res.durationMs}ms${savedNote}`;
  // Compose: command echo, body, optional stderr, trailer.
  return `$ ${command}\n${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${stderrBlock}${stderrBlock.endsWith("\n") ? "" : "\n"}${trailer}`;
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-bash", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__bash",
      description:
        "Run a shell command. Auto-compresses stdout > 2KB (head + tail with elided middle), and emits compact structured summaries for common commands (git status, ls, find, ps, npm ls). stderr is never compressed. Refuses catastrophic patterns and `cat <file>` (use ashlr__read instead). Lower-token alternative to the built-in Bash tool.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Working directory (default: process.cwd())" },
          timeout_ms: { type: "number", description: "Kill after N ms (default 60000)" },
          compact: { type: "boolean", description: "Auto-compress long output (default true)" },
        },
        required: ["command"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "ashlr__bash") {
      const text = await ashlrBash(args as unknown as BashArgs);
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr__bash error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
