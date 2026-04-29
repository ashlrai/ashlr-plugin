#!/usr/bin/env bun
/**
 * set-hook-mode.ts — Flip ~/.ashlr/config.json::hookMode.
 *
 * Usage:
 *   bun run scripts/set-hook-mode.ts redirect
 *   bun run scripts/set-hook-mode.ts nudge
 *   bun run scripts/set-hook-mode.ts off
 *
 * Prints: "ashlr hook mode set to <mode>. Restart Claude Code to apply."
 * Exits 1 with an error message on invalid input.
 *
 * Design:
 *   - Reads existing config.json to preserve other keys.
 *   - Writes atomically (write to tmp, then rename — avoids corruption if
 *     killed mid-write).
 *   - Creates ~/.ashlr/ if it doesn't exist.
 *   - Never touches settings.json or any other file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type HookMode = "redirect" | "nudge" | "off";

const VALID_MODES: HookMode[] = ["redirect", "nudge", "off"];

function configPath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".ashlr", "config.json");
}

/**
 * Set the hook mode in ~/.ashlr/config.json.
 * Returns the path written to — exported so tests can call directly.
 */
export function setHookMode(mode: HookMode, home?: string): string {
  const p = configPath(home);
  mkdirSync(dirname(p), { recursive: true });

  // Read existing config, preserve other keys.
  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      existing = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch {
      // Overwrite corrupt config.
      existing = {};
    }
  }

  existing.hookMode = mode;

  // Atomic write via tmp + rename.
  const tmp = p + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);

  return p;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const arg = process.argv[2];

  if (!arg || !(VALID_MODES as string[]).includes(arg)) {
    process.stderr.write(
      `Error: invalid hook mode "${arg ?? ""}". ` +
      `Valid values: redirect, nudge, off.\n` +
      `Usage: bun run scripts/set-hook-mode.ts <redirect|nudge|off>\n`,
    );
    process.exit(1);
  }

  const mode = arg as HookMode;
  setHookMode(mode);
  process.stdout.write(
    `ashlr hook mode set to ${mode}. Restart Claude Code to apply.\n`,
  );
}
