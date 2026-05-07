#!/usr/bin/env bun
/**
 * userpromptsubmit-brief-trigger.ts — UserPromptSubmit hook that watches for
 * natural-language activation phrases and toggles ashlr-brief in response.
 *
 * Activation phrases (case-insensitive, matches anywhere in prompt):
 *   "be brief", "be terse", "less tokens", "fewer tokens", "tldr",
 *   "/brief on", "brief mode on"
 *
 * Deactivation phrases:
 *   "stop being brief", "normal mode", "verbose mode", "brief off",
 *   "/brief off"
 *
 * Updates ~/.ashlr/brief.json and emits a status nudge in additionalContext
 * so the user sees confirmation of the toggle.
 *
 * Hook contract (UserPromptSubmit):
 *   stdin  → { prompt: string, ... }
 *   stdout → { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *                                    additionalContext?: string } }
 *
 * Design:
 *   - Never blocks (always exits 0).
 *   - Best-effort stdin parse — falls through silently on any error.
 *   - Writes only when the toggle actually changes state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext?: string;
  };
}

interface BriefConfig {
  level?: "off" | "lite" | "standard" | "concise";
  source?: "user" | "project";
  setAt?: string;
}

const ON_PATTERNS: Array<{ re: RegExp; level: "lite" | "standard" | "concise" }> = [
  { re: /\bbrief\s+(?:mode\s+)?on\b/i, level: "standard" },
  { re: /\bbe\s+brief\b/i,             level: "standard" },
  { re: /\bbe\s+terse\b/i,             level: "standard" },
  { re: /\bless\s+tokens?\b/i,         level: "standard" },
  { re: /\bfewer\s+tokens?\b/i,        level: "standard" },
  { re: /\btl;?dr\b/i,                 level: "concise" },
  { re: /\/brief\s+on\b/i,             level: "standard" },
];

const OFF_PATTERNS: RegExp[] = [
  /\bstop\s+(?:being\s+)?brief\b/i,
  /\bnormal\s+mode\b/i,
  /\bverbose\s+mode\b/i,
  /\bbrief\s+off\b/i,
  /\/brief\s+off\b/i,
];

function home(): string {
  return process.env.HOME ?? homedir();
}

function briefConfigPath(homeDir: string): string {
  return join(homeDir, ".ashlr", "brief.json");
}

function readConfig(homeDir: string): BriefConfig {
  const path = briefConfigPath(homeDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BriefConfig;
  } catch {
    return {};
  }
}

function writeConfig(homeDir: string, cfg: BriefConfig): void {
  const path = briefConfigPath(homeDir);
  mkdirSync(join(homeDir, ".ashlr"), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...cfg, setAt: new Date().toISOString(), source: "user" }, null, 2));
}

/** Returns the new level and a human-readable message, or null when no toggle was triggered. */
export function detectToggle(prompt: string): { level: "off" | "lite" | "standard" | "concise"; reason: string } | null {
  // OFF patterns first (so "stop being brief" beats "be brief")
  for (const re of OFF_PATTERNS) {
    if (re.test(prompt)) {
      return { level: "off", reason: `matched: ${re}` };
    }
  }
  // Explicit level via "brief = concise" / "brief on lite" / "/brief on lite" / etc.
  // Allow either "brief = LEVEL", "brief on LEVEL", "brief LEVEL", or "/brief on LEVEL".
  const levelMatch = prompt.match(/\/?\bbrief(?:\s*=\s*|\s+(?:mode\s+)?on\s+|\s+)(lite|standard|concise)\b/i);
  if (levelMatch && levelMatch[1]) {
    return { level: levelMatch[1].toLowerCase() as "lite" | "standard" | "concise", reason: "explicit level" };
  }
  for (const { re, level } of ON_PATTERNS) {
    if (re.test(prompt)) {
      return { level, reason: `matched: ${re}` };
    }
  }
  return null;
}

async function main(): Promise<void> {
  try {
    let stdin = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) stdin += chunk;
    if (!stdin.trim()) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }
    const payload = JSON.parse(stdin) as { prompt?: string };
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

    const toggle = detectToggle(prompt);
    if (!toggle) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }

    const h = home();
    const cfg = readConfig(h);
    const previous = cfg.level ?? "off";
    if (previous === toggle.level) {
      // No state change.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }

    writeConfig(h, { level: toggle.level });

    const note = toggle.level === "off"
      ? "[ashlr-brief] disabled — full verbosity restored for the next response."
      : `[ashlr-brief] activated at level "${toggle.level}". Code blocks, errors, and destructive-action confirmations remain in full grammar. Toggle off with: stop being brief.`;

    const out: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: note,
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
  }
}

if (import.meta.main) {
  void main();
}
