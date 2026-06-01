#!/usr/bin/env bun
/**
 * sessionstart-lean-tools.ts — SessionStart hook for the ashlr-lean-tools skill.
 *
 * Injects the ashlr-lean-tools ruleset as additionalContext when
 * ~/.ashlr/lean-tools.json { "enabled": true } (or project-level .ashlr/lean-tools.json).
 *
 * Contract: never throws, always exits 0.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { noteHookError } from "./_hook-errors";

interface SkillConfig {
  enabled?: boolean;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext?: string;
  };
}

const SKILL_KEY = "lean-tools";

const RULESET = `[ashlr-lean-tools] Highest-impact token-saving habits active.
1. Read-once: do not re-read a file already in context (it hasn't changed).
2. Batch edits: use ashlr__multi_edit for 2+ edits to the same file.
3. Orient before searching: run ashlr__orient once per task before any grep/glob.
4. Skip verification reads: ashlr__edit and ashlr__write return a diff — do not re-read to confirm.
5. Grep-before-read: run ashlr__grep first; open the file only if you need more than what grep returned.
6. Shift to concise output when session spend is high (>5,000 tool-output tokens): file:line citations over quoted blocks, skip preamble.
7. Use ashlr__bash over native Bash for verbose commands (test runners, git log, find).`;

function safeReadJson(path: string): SkillConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SkillConfig;
  } catch (e) {
    noteHookError(`sessionstart-${SKILL_KEY}`, `parse:${path}`, e);
    return null;
  }
}

function findRepoRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, "package.json"))) return cur;
    const parent = join(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export function isEnabled(opts?: { homeDir?: string; cwd?: string }): boolean {
  const h = opts?.homeDir ?? (process.env.HOME ?? homedir());
  const cwd = opts?.cwd ?? process.cwd();

  // Project-level wins.
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const cfg = safeReadJson(join(repoRoot, ".ashlr", `${SKILL_KEY}.json`));
    if (cfg !== null) return cfg.enabled === true;
  }

  // User-level.
  const userCfg = safeReadJson(join(h, ".ashlr", `${SKILL_KEY}.json`));
  return userCfg?.enabled === true;
}

export function buildAdditionalContext(): string {
  return RULESET;
}

async function main(): Promise<void> {
  try {
    const enabled = isEnabled();
    const out: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        ...(enabled ? { additionalContext: buildAdditionalContext() } : {}),
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    noteHookError(`sessionstart-${SKILL_KEY}`, "main", e);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart" } }));
  }
}

if (import.meta.main) {
  void main();
}
