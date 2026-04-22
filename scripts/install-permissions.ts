#!/usr/bin/env bun
/**
 * install-permissions.ts — add ashlr MCP tool wildcards to ~/.claude/settings.json
 * so Claude Code stops prompting on every mcp__ashlr-*__ call in bypassPermissions mode.
 *
 * Usage:
 *   bun run scripts/install-permissions.ts            # add entries
 *   bun run scripts/install-permissions.ts --dry-run  # preview without writing
 *   bun run scripts/install-permissions.ts --remove   # undo (strip ashlr entries)
 *   bun run scripts/install-permissions.ts --settings /path/to/settings.json
 *
 * Exits 0 on success; 1 only on unrecoverable I/O errors.
 */

import { existsSync } from "fs";
import { mkdir, readFile, realpath, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

// ---------- types ----------

export interface PermissionsResult {
  added: string[];
  alreadyPresent: string[];
  removed: string[];
  dryRun: boolean;
  settingsPath: string;
}

// ---------- plugin.json helpers ----------

function findPluginRoot(startDir: string): string | null {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot && existsSync(join(envRoot, ".claude-plugin/plugin.json"))) return envRoot;
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".claude-plugin/plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function readMcpServerNames(pluginRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      const keys = Object.keys(parsed.mcpServers);
      // v1.13 router consolidation: a single "ashlr" entry fronts every tool.
      // Existing user settings.json blocks (mcp__ashlr-efficiency__*, etc.)
      // still need the per-server wildcards to match, so fall through to the
      // hardcoded list below when the manifest is collapsed.
      if (!(keys.length === 1 && keys[0] === "ashlr")) {
        return keys;
      }
    }
  } catch {
    // fall through to default list
  }
  // fallback: hard-coded list in case plugin.json is unreadable
  return [
    "ashlr-efficiency",
    "ashlr-sql",
    "ashlr-bash",
    "ashlr-tree",
    "ashlr-http",
    "ashlr-diff",
    "ashlr-logs",
    "ashlr-genome",
    "ashlr-orient",
    "ashlr-github",
    "ashlr-glob",
    "ashlr-webfetch",
  ];
}

/** Build the full list of allow entries we manage: per-server wildcards + catch-all. */
export function buildAshlrEntries(serverNames: string[]): string[] {
  const entries: string[] = serverNames.map((name) => `mcp__${name}__*`);
  // catch-all for future servers
  entries.push("mcp__ashlr-*");
  return entries;
}

/** Returns true if `entry` is one we own (matches ashlr pattern). */
export function isAshlrEntry(entry: string): boolean {
  return /^mcp__ashlr(-|__)/.test(entry) || entry === "mcp__ashlr-*";
}

// ---------- settings.json I/O ----------

export async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    // Resolve symlinks so rename() lands at the real path
    const resolved = await realpath(settingsPath).catch(() => settingsPath);
    const raw = await readFile(resolved, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // missing file or malformed JSON → start fresh
  }
  return {};
}

async function writeSettingsAtomic(settingsPath: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + ".tmp." + process.pid + "." + randomBytes(3).toString("hex");
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    // If the file is a symlink resolve to target for the rename
    const target = await realpath(settingsPath).catch(() => settingsPath);
    await rename(tmp, target);
  } catch (err) {
    // best-effort: temp file cleanup on a failed rename — if unlink itself fails (e.g. file already gone) the original rename error is still what the caller needs to see, so swallow this.
    await import("fs/promises").then((m) => m.unlink(tmp)).catch(() => {});
    throw err;
  }
}

// ---------- core logic ----------

export interface InstallOptions {
  dryRun?: boolean;
  remove?: boolean;
  settingsPath?: string;
  pluginRoot?: string;
}

export async function installPermissions(opts: InstallOptions = {}): Promise<PermissionsResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const resolvedRoot = opts.pluginRoot ?? findPluginRoot(here) ?? here;
  const settingsPath = opts.settingsPath ?? join(homedir(), ".claude/settings.json");

  const serverNames = await readMcpServerNames(resolvedRoot);
  const ashlrEntries = buildAshlrEntries(serverNames);

  const settings = await readSettings(settingsPath);

  // Ensure permissions.allow exists
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
    settings.permissions = {};
  }
  const perms = settings.permissions as Record<string, unknown>;
  if (!Array.isArray(perms.allow)) {
    perms.allow = [];
  }
  const allow = perms.allow as string[];

  const result: PermissionsResult = {
    added: [],
    alreadyPresent: [],
    removed: [],
    dryRun: opts.dryRun ?? false,
    settingsPath,
  };

  if (opts.remove) {
    // Strip all ashlr entries
    const before = allow.length;
    const kept = allow.filter((e) => !isAshlrEntry(e));
    result.removed = allow.filter((e) => isAshlrEntry(e));
    if (!opts.dryRun && result.removed.length > 0) {
      perms.allow = kept;
      await writeSettingsAtomic(settingsPath, settings);
    }
    return result;
  }

  // Add mode: idempotent
  for (const entry of ashlrEntries) {
    if (allow.includes(entry)) {
      result.alreadyPresent.push(entry);
    } else {
      result.added.push(entry);
    }
  }

  if (!opts.dryRun && result.added.length > 0) {
    for (const entry of result.added) {
      allow.push(entry);
    }
    await writeSettingsAtomic(settingsPath, settings);
  }

  return result;
}

// ---------- main ----------

function formatResult(r: PermissionsResult): string {
  const lines: string[] = [];
  const prefix = r.dryRun ? "[dry-run] " : "";

  if (r.removed.length > 0) {
    lines.push(`${prefix}Removed ${r.removed.length} ashlr permission entr${r.removed.length === 1 ? "y" : "ies"}:`);
    for (const e of r.removed) lines.push(`  - ${e}`);
  } else if (r.added.length === 0 && r.alreadyPresent.length === 0 && !r.removed.length) {
    // remove mode, nothing to do
    lines.push(`${prefix}No ashlr permission entries found to remove.`);
  }

  if (r.added.length > 0) {
    lines.push(`${prefix}Added ${r.added.length} entr${r.added.length === 1 ? "y" : "ies"} to ${r.settingsPath}:`);
    for (const e of r.added) lines.push(`  + ${e}`);
  }

  if (r.alreadyPresent.length > 0) {
    lines.push(`Already present (${r.alreadyPresent.length}): ${r.alreadyPresent.join(", ")}`);
  }

  if (r.added.length === 0 && r.alreadyPresent.length > 0 && r.removed.length === 0) {
    lines.push("All ashlr MCP tool entries already in allowlist. Nothing to do.");
  }

  if (!r.dryRun && r.added.length > 0) {
    lines.push("");
    lines.push("Restart Claude Code (or run /reload-plugins) to pick up the new permissions.");
  }

  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const remove = args.includes("--remove");

  let settingsPath: string | undefined;
  const settingsIdx = args.indexOf("--settings");
  if (settingsIdx !== -1 && args[settingsIdx + 1]) {
    settingsPath = args[settingsIdx + 1];
  }

  try {
    const result = await installPermissions({ dryRun, remove, settingsPath });
    process.stdout.write(formatResult(result) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(
      `ashlr install-permissions: I/O error — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
