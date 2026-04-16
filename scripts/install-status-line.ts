#!/usr/bin/env bun
/**
 * One-shot installer that wires the ashlr status-line script into the user's
 * Claude Code settings.
 *
 * Strategy for safe merging:
 *   1. Read ~/.claude/settings.json if it exists; parse it as JSON. If the file
 *      is corrupt, abort loudly — we will not overwrite a file we can't parse.
 *   2. Take a timestamped backup (settings.json.bak-<epoch>) before writing.
 *   3. Shallow-merge: set settings.statusLine = { type: "command", command: "..." }
 *      only if statusLine is missing OR already points at our script. We never
 *      clobber a custom statusLine the user has configured for something else.
 *   4. Ensure settings.ashlr defaults exist (statusLine + sub-toggles), again
 *      only filling in keys that aren't already set.
 *   5. Write back with 2-space indent, preserving every other top-level key.
 *
 * Idempotent: re-running is a no-op aside from refreshing the absolute path
 * to the script (in case the plugin moved).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { c, sym, box, isColorEnabled, prefix } from "./ui.ts";

interface StatusLineCmd {
  type: "command";
  command: string;
  padding?: number;
}

interface ClaudeSettings {
  statusLine?: StatusLineCmd | unknown;
  ashlr?: Record<string, unknown>;
  [k: string]: unknown;
}

const SCRIPT_PATH = resolve(import.meta.dir, "savings-status-line.ts");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const COMMAND = `bun run ${SCRIPT_PATH}`;

function isOurStatusLine(sl: unknown): sl is StatusLineCmd {
  if (!sl || typeof sl !== "object") return false;
  const cmd = (sl as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.includes("savings-status-line");
}

function main(): void {
  let settings: ClaudeSettings = {};
  let existed = false;

  if (existsSync(SETTINGS_PATH)) {
    existed = true;
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    try {
      settings = JSON.parse(raw) as ClaudeSettings;
    } catch (err) {
      const msg = (err as Error).message;
      const head = isColorEnabled()
        ? `${c.red(sym.cross)} ${c.bold("refusing to touch")} ${c.cyan(SETTINGS_PATH)}`
        : `refusing to touch ${SETTINGS_PATH}`;
      console.error(`${head}: not valid JSON (${msg})`);
      process.exit(1);
    }
    // Backup before any write.
    const backup = `${SETTINGS_PATH}.bak-${Date.now()}`;
    copyFileSync(SETTINGS_PATH, backup);
  } else {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  }

  const actions: string[] = [];

  // 1. statusLine command
  const currentSl = settings.statusLine;
  if (!currentSl) {
    settings.statusLine = { type: "command", command: COMMAND, padding: 0 };
    actions.push("added statusLine command");
  } else if (isOurStatusLine(currentSl)) {
    if ((currentSl as StatusLineCmd).command !== COMMAND) {
      (settings.statusLine as StatusLineCmd).command = COMMAND;
      actions.push("refreshed statusLine command path");
    } else {
      actions.push("statusLine already installed (no change)");
    }
  } else {
    const warnHead = isColorEnabled()
      ? `${c.yellow(sym.warn)} ${c.bold("warning:")}`
      : "warning:";
    console.warn(
      `${warnHead} an existing statusLine is configured and points elsewhere; leaving it alone.`,
    );
    const cmd = isColorEnabled() ? c.cyan(COMMAND) : COMMAND;
    console.warn(`  to use ashlr instead, set statusLine.command to: ${cmd}`);
  }

  // 2. ashlr defaults
  const ashlr = (settings.ashlr ??= {}) as Record<string, unknown>;
  const defaults: Record<string, boolean> = {
    statusLine: true,
    statusLineSession: true,
    statusLineLifetime: true,
    statusLineTips: true,
  };
  let addedDefaults = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in ashlr)) {
      ashlr[k] = v;
      addedDefaults++;
    }
  }
  if (addedDefaults > 0) actions.push(`seeded ${addedDefaults} ashlr default toggle(s)`);

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  const verb = existed ? "updated" : "created";
  const verbColored = isColorEnabled() ? c.brightGreen(c.bold(verb)) : verb;
  const pathColored = isColorEnabled() ? c.cyan(SETTINGS_PATH) : SETTINGS_PATH;
  console.log(`${prefix.ok(`${verbColored} ${pathColored}`)}`);
  for (const a of actions) {
    const dotGlyph = isColorEnabled() ? c.magenta(sym.bullet) : "-";
    console.log(`  ${dotGlyph} ${a}`);
  }
  const scriptLabel = isColorEnabled() ? c.dim("status-line script:") : "status-line script:";
  const scriptColored = isColorEnabled() ? c.cyan(SCRIPT_PATH) : SCRIPT_PATH;
  console.log(`${scriptLabel} ${scriptColored}`);

  // On a TTY, include a small summary box so the install feels complete.
  if (isColorEnabled()) {
    const body = [
      `${prefix.ok("status line wired")}`,
      `  reload Claude Code to see it`,
      `  toggle anytime via ${c.cyan("/ashlr-settings")}`,
    ].join("\n");
    console.log("");
    console.log(box(body, { title: "ashlr status line", color: c.green }));
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    const head = isColorEnabled()
      ? `${c.red(sym.cross)} ${c.bold("install-status-line failed:")}`
      : "install-status-line failed:";
    console.error(`${head} ${(err as Error).message}`);
    process.exit(1);
  }
}
