#!/usr/bin/env bun
/**
 * sessionstart-search.ts — SessionStart hook for the ashlr-search skill.
 *
 * Injects the ashlr-search ruleset as additionalContext when
 * ~/.ashlr/search.json { "enabled": true } (or project-level .ashlr/search.json).
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

const SKILL_KEY = "search";

const RULESET = `[ashlr-search] Genome-aware search habits active.
1. Run ashlr__orient once per task before any grep or glob.
2. Use ashlr__grep instead of native Grep — genome-aware, 70–90% lower token cost.
3. Use ashlr__glob instead of native Glob.
4. Compose multi-term queries with | alternation (one call beats three).
5. Trust genome section summaries — do NOT open the referenced file unless you need exact line content for an edit.
6. Do not re-search patterns already in context.`;

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
