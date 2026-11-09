#!/usr/bin/env bun
/**
 * ashlr-plugin CLI. Run `ashlr-plugin help` for the terminal command list.
 * The launcher handles --ashlr-handshake before invoking this file.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildCodexDoctorReport, formatCodexDoctorText } from "./lib/codex-doctor.ts";

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

function usage(exitCode = 1): never {
  process.stderr.write(
    `usage:\n` +
    `  ashlr-plugin stats --json [--session <id>] [--since <YYYY-MM-DD>] [--tool <name>]\n` +
    `      print the local savings ledger (or one slice of it) as JSON\n` +
    `  ashlr-plugin tools [--json]\n` +
    `      list the MCP tools the router registers\n` +
    `  ashlr-plugin mcp\n` +
    `      start the stdio MCP router\n` +
    `  ashlr-plugin codex-start [--json]\n` +
    `  ashlr-plugin codex-resume [--json]\n` +
    `  ashlr-plugin codex-end [--json]\n` +
    `      print Codex session start, resume, and end guidance (no hooks run)\n` +
    `  ashlr-plugin codex-doctor [--json]\n` +
    `      check the plugin's install and Codex packaging (alias: doctor)\n` +
    `  ashlr-plugin codex-install --dry-run [--json]\n` +
    `      show the Codex config changes an install would make\n` +
    `  ashlr-plugin genome-refresh [--json] [--full] [--dry-run] [--quiet] [--debounce <ms>]\n` +
    `      refresh genome sections for changed files\n` +
    `  ashlr-plugin selftest [--json] [--only <id|command,...>] [--keep-tmp] [--timeout-ms <n>]\n` +
    `      run every command's entry point against a fixture repo\n` +
    `  ashlr-plugin version\n` +
    `      print the plugin version\n`,
  );
  process.exit(exitCode);
}

function repoRootFromCli(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

function loadStats(): Record<string, unknown> {
  if (!existsSync(STATS_PATH)) {
    // No savings recorded yet: answer with an empty ledger so `--json`
    // callers always get JSON.
    return {
      schemaVersion: 2,
      sessions: {},
      lifetime: { calls: 0, tokensSaved: 0, rawTotal: 0, byTool: {}, byDay: {} },
    };
  }
  try {
    return JSON.parse(readFileSync(STATS_PATH, "utf-8"));
  } catch (err) {
    process.stderr.write(`ashlr-plugin: ${STATS_PATH} is not valid JSON (${String(err)})\n`);
    process.exit(1);
  }
}

function readPluginVersion(): string {
  const candidates = [
    join(repoRootFromCli(), "package.json"),
    join(repoRootFromCli(), "..", "package.json"),
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
      process.stderr.write(`ashlr-plugin: --since must be YYYY-MM-DD (got ${since})\n`);
      process.exit(1);
    }
    // The ledger keeps per-day totals in lifetime.byDay (older builds of this
    // command read a `daily` key that the ledger never had).
    const lifetime = (stats.lifetime ?? {}) as { byDay?: Record<string, unknown> };
    const daily = lifetime.byDay ?? {};
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

async function runMcp(): Promise<void> {
  const root = repoRootFromCli();
  process.env.ASHLR_MCP_HOST ||= "generic";
  // The router runs from the plugin root; keep the caller's folder (the
  // user's project) so the router can move back into it.
  process.env.ASHLR_LAUNCH_CWD ||= process.cwd();
  const proc = Bun.spawn(
    ["bun", "run", join(root, "scripts", "mcp-entrypoint.ts"), "servers/_router.ts"],
    {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    },
  );
  const code = await proc.exited;
  process.exit(code);
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

type JsonFlagMap = Record<string, string | boolean>;

function runCodexLifecycle(name: "codex-start" | "codex-resume" | "codex-end", flags: JsonFlagMap): void {
  const payload = {
    ok: true,
    command: name,
    host: "codex-cli",
    next:
      name === "codex-end"
        ? "Review ashlr savings with `ashlr-plugin stats --json`."
        : "Use ashlr__orient, ashlr__grep, and ashlr__read for token-efficient context gathering.",
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`[ashlr] ${payload.command}: ${payload.next}\n`);
}

function runCodexDoctor(flags: JsonFlagMap): void {
  const report = buildCodexDoctorReport(repoRootFromCli());
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatCodexDoctorText(report));
}

function runCodexInstall(flags: JsonFlagMap): void {
  if (!flags["dry-run"]) {
    process.stderr.write("ashlr: codex-install currently supports --dry-run only\n");
    process.exit(1);
  }
  const root = repoRootFromCli();
  const plan = {
    dryRun: true,
    writes: [
      {
        path: "~/.codex/config.toml",
        action: "add_or_update_mcp_server",
        server: "ashlr",
        command: "ashlr-mcp",
        cwd: ".",
        env: { ASHLR_MCP_HOST: "codex-cli", ASHLR_CODEX_HOOK_MODE: "nudge" },
      },
    ],
    plugin: {
      manifest: join(root, ".codex-plugin", "plugin.json"),
      marketplace: join(root, ".agents", "plugins", "marketplace.json"),
      agents: join(root, ".codex", "agents"),
    },
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    "ashlr Codex install dry run:\n" +
      "- would add mcp_servers.ashlr to ~/.codex/config.toml\n" +
      "- command: ashlr-mcp\n" +
      "- env: ASHLR_MCP_HOST=codex-cli\n" +
      "- agents: .codex/agents/ashlr-explorer.md and ashlr-worker.md\n",
  );
}

async function runGenomeRefresh(flags: JsonFlagMap): Promise<void> {
  const root = repoRootFromCli();
  const worker = join(root, "scripts", "genome-refresh-worker.ts");
  if (!existsSync(worker)) {
    process.stderr.write("ashlr: genome refresh worker missing\n");
    process.exit(1);
  }
  const { run } = await import("./genome-refresh-worker");
  const debounceRaw = typeof flags.debounce === "string" ? parseInt(flags.debounce, 10) : NaN;
  const summary = await run({
    full: flags.full === true,
    dryRun: flags["dry-run"] === true,
    quiet: flags.json === true || flags.quiet === true,
    debounceMs: Number.isFinite(debounceRaw) ? debounceRaw : 0,
    home: process.env.ASHLR_HOME_OVERRIDE ?? process.env.HOME ?? homedir(),
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, command: "genome-refresh", worker, summary }, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `[ashlr] genome refresh: ${summary.filesProcessed} files, ` +
      `${summary.sectionsUpdated} updated, ${summary.sectionsInvalidated} invalidated, ` +
      `${summary.genomeRoots.length} genome root(s)\n`,
  );
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
    case "mcp":
      await runMcp();
      break;
    case "codex-start":
    case "codex-resume":
    case "codex-end":
      runCodexLifecycle(subcommand, flags);
      break;
    case "codex-doctor":
    case "doctor":
      runCodexDoctor(flags);
      break;
    case "codex-install":
      runCodexInstall(flags);
      break;
    case "genome-refresh":
      await runGenomeRefresh(flags);
      break;
    case "selftest": {
      // Forward the raw tail (selftest parses its own flags: --json, --only,
      // --keep-tmp, --timeout-ms) so cli.ts never has to mirror its options.
      const { runSelftest, formatReport, parseSelftestArgs, SELFTEST_USAGE } = await import("./selftest.ts");
      const opts = parseSelftestArgs(process.argv.slice(3));
      if (opts.help) {
        process.stdout.write(SELFTEST_USAGE);
        process.exit(0);
      }
      const { report, code } = await runSelftest(opts);
      process.stdout.write(
        (opts.json ? JSON.stringify(report, null, 2) : formatReport(report)) + "\n",
      );
      process.exit(code);
    }
    case "version":
    case "--version":
    case "-v":
      runVersion();
      break;
    case "--help":
    case "-h":
    case "help":
      usage(0);
      break;
    default:
      process.stderr.write(`ashlr-plugin: unknown subcommand "${subcommand}"\n`);
      usage();
  }
}

await main();
