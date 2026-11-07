/** Codex packaging report behind `ashlr-plugin codex-doctor`. Pure over a
 * plugin root and an env map, so tests can point it at a fixture tree.
 *
 * A file that exists but does not parse is reported as `invalid JSON`, not
 * `missing`: "missing" sends the user looking for a file that is already there. */
import { accessSync, constants, existsSync, readFileSync } from "fs";
import { delimiter, join } from "path";

export interface JsonFile<T> {
  /** The file is on disk, whether or not it parses. */
  exists: boolean;
  /** Parsed contents; null when the file is missing or does not parse. */
  value: T | null;
  /** JSON.parse message when the file exists but is not valid JSON. */
  parseError: string | null;
}

export function readJsonFile<T>(path: string): JsonFile<T> {
  if (!existsSync(path)) return { exists: false, value: null, parseError: null };
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, "utf-8")) as T, parseError: null };
  } catch (err) {
    return { exists: true, value: null, parseError: err instanceof Error ? err.message : String(err) };
  }
}

/** `present` keeps its old meaning for valid files; `valid` is the new signal. */
interface FileSection {
  path: string;
  present: boolean;
  valid: boolean;
  parseError: string | null;
}

export interface CodexDoctorReport {
  ok: boolean;
  pluginManifest: FileSection & { hasSkills: boolean; hasMcpServers: boolean; hasHooks: boolean };
  mcp: FileSection & {
    server: boolean;
    command: string | null;
    cwd: string | null;
    host: string | null;
    hookMode: string | null;
    hasInstructions: boolean;
    mentionsWorkspaceAllowlist: boolean;
    bin: string | null;
    binDeclared: boolean;
    binResolvable: boolean;
    installMode: "package-bin" | "source-checkout";
    sourceCheckoutCommand: string;
    note: string;
  };
  hooks: FileSection & {
    defaultMode: string;
    events: string[];
    bootstrapDefaultsHost: boolean;
    rootVariable: string | null;
    referencedHookFiles: string[];
    hookFilesExist: boolean;
    portableCommands: boolean;
  };
  skills: { path: string; present: boolean };
  agents: { path: string; present: boolean; files: string[]; note: string };
  workspaceAccess: { cwd: string; allowProjectPaths: string[]; note: string };
  claudeOnly: string[];
}

/** True when `command` resolves to an executable on the given PATH. */
export function commandOnPath(command: string, pathEnv: string | undefined): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (pathEnv ?? "").split(delimiter).filter(Boolean)) {
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

export function buildCodexDoctorReport(root: string, env: NodeJS.ProcessEnv = process.env): CodexDoctorReport {
  const pkg = readJsonFile<{ bin?: Record<string, string> }>(join(root, "package.json")).value;
  const pluginFile = readJsonFile<Record<string, unknown>>(join(root, ".codex-plugin", "plugin.json"));
  const mcpFile = readJsonFile<{
    mcpServers?: Record<string, {
      command?: string;
      cwd?: string;
      env?: Record<string, string>;
      instructions?: string;
    }>;
  }>(join(root, ".mcp.json"));
  const hooksFile = readJsonFile<{ hooks?: Record<string, unknown> }>(join(root, "hooks", "codex-hooks.json"));
  const plugin = pluginFile.value;
  const mcp = mcpFile.value;
  const hooks = hooksFile.value;
  const skillsPresent = existsSync(join(root, "skills"));
  const codexAgentsDir = join(root, ".codex", "agents");
  const codexAgentFiles = ["ashlr-explorer.md", "ashlr-worker.md"].filter((name) => existsSync(join(codexAgentsDir, name)));
  const server = mcp?.mcpServers?.ashlr;
  const instructions = typeof server?.instructions === "string" ? server.instructions : "";
  const allowlist = env.ASHLR_ALLOW_PROJECT_PATHS ?? "";
  const mcpBinDeclared = pkg?.bin?.["ashlr-mcp"] === "./scripts/ashlr-mcp.mjs";
  const mcpBinResolvable = commandOnPath("ashlr-mcp", env.PATH);
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
  return {
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
      present: pluginFile.exists,
      valid: plugin !== null,
      parseError: pluginFile.parseError,
      hasSkills: plugin?.skills === "./skills/",
      hasMcpServers: plugin?.mcpServers === "./.mcp.json",
      hasHooks: plugin?.hooks === "./hooks/codex-hooks.json",
    },
    mcp: {
      path: ".mcp.json",
      present: mcpFile.exists,
      valid: mcp !== null,
      parseError: mcpFile.parseError,
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
      present: hooksFile.exists,
      valid: hooks !== null,
      parseError: hooksFile.parseError,
      defaultMode: env.ASHLR_CODEX_HOOK_MODE ?? "nudge",
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
}

/** "missing", "invalid JSON (<path>)", or "present" for one config file. */
function fileState(file: FileSection): string {
  if (!file.present) return "missing";
  if (!file.valid) return `invalid JSON (${file.path})`;
  return "present";
}

export function formatCodexDoctorText(report: CodexDoctorReport): string {
  // A .mcp.json that is absent or unreadable has no server to find: say that, not "missing".
  const serverState = report.mcp.valid ? (report.mcp.server ? "present" : "missing") : fileState(report.mcp);
  return (
    `ashlr Codex doctor: ${report.ok ? "ok" : "issues found"}\n` +
    `- plugin manifest: ${fileState(report.pluginManifest)}\n` +
    `- MCP server: ${serverState} (${report.mcp.bin})\n` +
    // Report-only: `ok` does not depend on this. The plugin's .mcp.json runs
    // `ashlr-mcp`, so a host cannot start the server when it is not on PATH.
    (report.mcp.binResolvable
      ? "- MCP launch: ashlr-mcp is on PATH\n"
      : "- MCP launch: ashlr-mcp is not on PATH, so a host that runs .mcp.json cannot start the server. " +
        `Install the package bin (npm install -g ashlr-plugin) or point the host at: ${report.mcp.sourceCheckoutCommand}\n`) +
    `- hooks: ${fileState(report.hooks)} (${report.hooks.defaultMode})\n` +
    `- skills: ${report.skills.present ? "present" : "missing"}\n` +
    `- agents: ${report.agents.present ? "present" : "missing"}\n`
  );
}
