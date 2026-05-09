#!/usr/bin/env bun
/**
 * ashlr CLI — read-only access to the local stats ledger.
 *
 * Usage:
 *   ashlr stats --json                     # whole ledger as JSON
 *   ashlr stats --json --session <id>      # one session's bucket
 *   ashlr stats --json --since 2026-04-01  # lifetime entries since date
 *   ashlr stats --json --tool ashlr__read  # per-tool slice
 *   ashlr tools [--json]                    # list registered MCP tools
 *   ashlr version                          # print ashlr-plugin version
 *
 * Output is stable JSON on stdout. Errors go to stderr with a human-readable
 * line and exit code 1. Never mutates anything.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

function usage(): never {
  process.stderr.write(
    `usage:\n` +
    `  ashlr stats --json [--session <id>] [--since <YYYY-MM-DD>] [--tool <name>]\n` +
    `  ashlr tools [--json]\n` +
    `  ashlr version\n`,
  );
  process.exit(1);
}

function loadStats(): Record<string, unknown> {
  if (!existsSync(STATS_PATH)) {
    process.stderr.write(`ashlr: no stats yet at ${STATS_PATH}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(STATS_PATH, "utf-8"));
  } catch (err) {
    process.stderr.write(`ashlr: ${STATS_PATH} is not valid JSON (${String(err)})\n`);
    process.exit(1);
  }
}

function readPluginVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(c, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "unknown";
}

function parseArgs(argv: string[]): { subcommand: string; flags: Record<string, string | boolean> } {
  if (argv.length === 0) usage();
  const subcommand = argv[0]!;
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { subcommand, flags };
}

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------

function runStats(flags: Record<string, string | boolean>): void {
  if (!flags.json) usage();

  const stats = loadStats();
  let output: unknown = stats;

  const session = typeof flags.session === "string" ? flags.session : null;
  const since = typeof flags.since === "string" ? flags.since : null;
  const tool = typeof flags.tool === "string" ? flags.tool : null;

  if (session) {
    const sessions = (stats.sessions ?? {}) as Record<string, unknown>;
    output = sessions[session] ?? null;
  } else if (tool) {
    const lifetime = (stats.lifetime ?? {}) as { byTool?: Record<string, unknown> };
    const byTool = lifetime.byTool ?? {};
    output = byTool[tool] ?? null;
  } else if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      process.stderr.write(`ashlr: --since must be YYYY-MM-DD (got ${since})\n`);
      process.exit(1);
    }
    const lifetime = (stats.lifetime ?? {}) as { daily?: Record<string, unknown> };
    const daily = lifetime.daily ?? {};
    const filtered: Record<string, unknown> = {};
    for (const [date, entry] of Object.entries(daily)) {
      if (date >= since) filtered[date] = entry;
    }
    output = { daily: filtered };
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function runVersion(): void {
  process.stdout.write(`ashlr-plugin ${readPluginVersion()}\n`);
}

async function runTools(flags: Record<string, string | boolean>): Promise<void> {
  await import("../servers/_router-handlers");
  const { listTools } = await import("../servers/_tool-base");
  const tools = listTools()
    .map((tool) => ({ name: tool.name, description: tool.description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (flags.json) {
    process.stdout.write(JSON.stringify({ count: tools.length, tools }, null, 2) + "\n");
    return;
  }

  const width = Math.max(...tools.map((t) => t.name.length));
  const lines = [`ashlr MCP tools (${tools.length})`, ""];
  for (const tool of tools) {
    lines.push(`${tool.name.padEnd(width)}  ${tool.description}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));

  switch (subcommand) {
    case "stats":
      runStats(flags);
      break;
    case "tools":
      await runTools(flags);
      break;
    case "version":
    case "--version":
    case "-v":
      runVersion();
      break;
    case "--help":
    case "-h":
    case "help":
      usage();
      break;
    default:
      process.stderr.write(`ashlr: unknown subcommand "${subcommand}"\n`);
      usage();
  }
}

await main();
