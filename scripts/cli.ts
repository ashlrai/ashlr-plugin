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
 *   ashlr mcp                              # start the stdio MCP router
 *   ashlr codex-doctor --json              # Codex plugin packaging health
 *   ashlr codex-install --dry-run --json   # planned Codex config changes
 *
 * Output is stable JSON on stdout. Errors go to stderr with a human-readable
 * line and exit code 1. Never mutates anything.
 */

import { constants, existsSync, readFileSync, accessSync } from "fs";
import { homedir } from "os";
import { delimiter, join, dirname } from "path";
import { fileURLToPath } from "url";

const STATS_PATH = join(homedir(), ".ashlr", "stats.json");

function usage(): never {
  process.stderr.write(
    `usage:\n` +
    `  ashlr stats --json [--session <id>] [--since <YYYY-MM-DD>] [--tool <name>]\n` +
    `  ashlr tools [--json]\n` +
    `  ashlr mcp\n` +
    `  ashlr codex-start [--json]\n` +
    `  ashlr codex-resume [--json]\n` +
    `  ashlr codex-end [--json]\n` +
    `  ashlr codex-doctor [--json]\n` +
    `  ashlr codex-install --dry-run [--json]\n` +
    `  ashlr genome-refresh [--json]\n` +
    `  ashlr version\n`,
  );
  process.exit(1);
}

function repoRootFromCli(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
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

function readJsonIfExists<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function commandOnPath(command: string): boolean {
  const path = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, process.platform === "win32" && !command.toUpperCase().endsWith(ext) ? `${command}${ext}` : command);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // try next PATH entry
      }
    }
  }
  return false;
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

async function runMcp(): Promise<void> {
  const root = repoRootFromCli();
  process.env.ASHLR_MCP_HOST ||= "generic";
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
        ? "Review ashlr savings with `ashlr stats --json`."
        : "Use ashlr__orient, ashlr__grep, and ashlr__read for token-efficient context gathering.",
  };
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`[ashlr] ${payload.command}: ${payload.next}\n`);
}

function runCodexDoctor(flags: JsonFlagMap): void {
  const root = repoRootFromCli();
  const pkg = readJsonIfExists<{ bin?: Record<string, string> }>(join(root, "package.json"));
  const plugin = readJsonIfExists<Record<string, unknown>>(join(root, ".codex-plugin", "plugin.json"));
  const mcp = readJsonIfExists<{
    mcpServers?: Record<string, {
      command?: unknown;
      cwd?: unknown;
      env?: Record<string, unknown>;
      instructions?: unknown;
    }>;
  }>(join(root, ".mcp.json"));
  const hooks = readJsonIfExists<{ hooks?: Record<string, unknown> }>(join(root, "hooks", "codex-hooks.json"));
  const skillsPresent = existsSync(join(root, "skills"));
  const codexAgentsDir = join(root, ".codex", "agents");
  const codexAgentFiles = ["ashlr-explorer.md", "ashlr-worker.md"].filter((name) => existsSync(join(codexAgentsDir, name)));
  const server = mcp?.mcpServers?.ashlr;
  const instructions = typeof server?.instructions === "string" ? server.instructions : "";
  const allowlist = process.env.ASHLR_ALLOW_PROJECT_PATHS ?? "";
  const mcpBinDeclared = pkg?.bin?.["ashlr-mcp"] === "./scripts/ashlr-mcp.ts";
  const mcpBinResolvable = commandOnPath("ashlr-mcp");
  const sourceCheckoutCommand = `bun run ${join(root, "scripts", "ashlr-mcp.ts")}`;
  const mcpHealthy = Boolean(
    server &&
      server.command === "ashlr-mcp" &&
      server.cwd === "." &&
      server.env?.ASHLR_MCP_HOST === "codex-cli" &&
      server.env?.ASHLR_CODEX_HOOK_MODE === "nudge" &&
      instructions.includes("ashlr__read") &&
      instructions.includes("ashlr__grep") &&
      instructions.includes("ASHLR_ALLOW_PROJECT_PATHS"),
  );
  const hookEvents = Object.keys(hooks?.hooks ?? {});
  const hooksJson = JSON.stringify(hooks?.hooks ?? {});
  const hookCommands = hooks?.hooks
    ? Object.values(hooks.hooks).flatMap((groups) =>
        Array.isArray(groups)
          ? groups.flatMap((group) => {
              const hooksForGroup = (group as { hooks?: unknown }).hooks;
              return Array.isArray(hooksForGroup)
                ? hooksForGroup.map((hook) => (hook as { command?: unknown }).command).filter((cmd): cmd is string => typeof cmd === "string")
                : [];
            })
          : [],
      )
    : [];
  const referencedHookFiles = hookCommands
    .map((command) => command.match(/\/hooks\/([^"]+)"/)?.[1])
    .filter((name): name is string => Boolean(name));
  const hookFilesExist = referencedHookFiles.every((name) => existsSync(join(root, "hooks", name)));
  const hookRootPlaceholderSupported = hookCommands.every((command) => command.includes("${CODEX_PLUGIN_ROOT}"));
  const hooksHealthy = Boolean(
    hooks?.hooks &&
      hookEvents.includes("PreToolUse") &&
      hookEvents.includes("SessionStart") &&
      hookCommands.length > 0 &&
      hookRootPlaceholderSupported &&
      hookCommands.every((command) => command.includes("hook-bootstrap.mjs")) &&
      hookFilesExist &&
      !hooksJson.includes("ASHLR_CODEX_HOOK_MODE:-nudge"),
  );
  const pluginHealthy = Boolean(
    plugin &&
      plugin.skills === "./skills/" &&
      plugin.mcpServers === "./.mcp.json" &&
      plugin.hooks === "./hooks/codex-hooks.json",
  );
  const report = {
    ok: Boolean(
      pluginHealthy &&
        mcpHealthy &&
        hooksHealthy &&
        pkg?.bin?.["ashlr-mcp"] &&
        skillsPresent &&
        codexAgentFiles.length === 2,
    ),
    pluginManifest: {
      path: ".codex-plugin/plugin.json",
      present: Boolean(plugin),
      hasSkills: plugin?.skills === "./skills/",
      hasMcpServers: plugin?.mcpServers === "./.mcp.json",
      hasHooks: plugin?.hooks === "./hooks/codex-hooks.json",
    },
    mcp: {
      path: ".mcp.json",
      present: Boolean(mcp),
      server: Boolean(server),
      command: server?.command ?? null,
      cwd: server?.cwd ?? null,
      host: server?.env?.ASHLR_MCP_HOST ?? null,
      hookMode: server?.env?.ASHLR_CODEX_HOOK_MODE ?? null,
      hasInstructions: instructions.length > 0,
      mentionsWorkspaceAllowlist: instructions.includes("ASHLR_ALLOW_PROJECT_PATHS"),
      bin: pkg?.bin?.["ashlr-mcp"] ? "ashlr-mcp" : null,
      binDeclared: mcpBinDeclared,
      binResolvable: mcpBinResolvable,
      installMode: mcpBinResolvable ? "package-bin" : "source-checkout",
      sourceCheckoutCommand,
      note: mcpBinResolvable
        ? "ashlr-mcp is available on PATH."
        : "ashlr-mcp is declared by package.json but is not on PATH in this checkout; use the sourceCheckoutCommand for manual MCP configs until the package bin is installed.",
    },
    hooks: {
      path: "hooks/codex-hooks.json",
      present: Boolean(hooks),
      defaultMode: process.env.ASHLR_CODEX_HOOK_MODE ?? "nudge",
      events: hookEvents,
      bootstrapDefaultsHost: true,
      rootVariable: hookRootPlaceholderSupported ? "CODEX_PLUGIN_ROOT" : null,
      referencedHookFiles,
      hookFilesExist,
      portableCommands: !hooksJson.includes("ASHLR_CODEX_HOOK_MODE:-nudge"),
    },
    skills: {
      path: "skills/",
      present: skillsPresent,
    },
    agents: {
      path: ".codex/agents/",
      present: codexAgentFiles.length === 2,
      files: codexAgentFiles,
      note: "Optional Codex explorer/worker guidance for parallel research and scoped implementation.",
    },
    workspaceAccess: {
      cwd: process.cwd(),
      allowProjectPaths: allowlist ? allowlist.split(process.platform === "win32" ? ";" : ":") : [],
      note: "Set ASHLR_ALLOW_PROJECT_PATHS for extra Codex workspaces outside the MCP launch cwd.",
    },
    claudeOnly: [
      "statusLine",
      "Claude slash commands",
      "Claude OAuth bootstrap",
      "ASHLR_HOOK_MODE=redirect auto-redirect defaults",
    ],
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `ashlr Codex doctor: ${report.ok ? "ok" : "issues found"}\n` +
      `- plugin manifest: ${report.pluginManifest.present ? "present" : "missing"}\n` +
      `- MCP server: ${report.mcp.server ? "present" : "missing"} (${report.mcp.bin})\n` +
      `- hooks: ${report.hooks.present ? "present" : "missing"} (${report.hooks.defaultMode})\n` +
      `- skills: ${report.skills.present ? "present" : "missing"}\n` +
      `- agents: ${report.agents.present ? "present" : "missing"}\n`,
  );
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
      runCodexDoctor(flags);
      break;
    case "codex-install":
      runCodexInstall(flags);
      break;
    case "genome-refresh":
      await runGenomeRefresh(flags);
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
