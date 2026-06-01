#!/usr/bin/env bun
/**
 * sessionstart-cost-refactor.ts — SessionStart hook for the ashlr-cost-refactor skill.
 *
 * Injects the ashlr-cost-refactor ruleset as additionalContext when
 * ~/.ashlr/cost-refactor.json { "enabled": true } (or project-level .ashlr/cost-refactor.json).
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

const SKILL_KEY = "cost-refactor";

const RULESET = `[ashlr-cost-refactor] Token-efficient refactoring discipline active.
1. Diff first: run ashlr__diff or ashlr__diff_semantic before editing anything.
2. Use ashlr__edit_structural for symbol/file renames (finds all refs in one pass).
3. Find all refs with ashlr__grep, then apply all changes to each file in a single ashlr__multi_edit call.
4. No re-reads between edits in a sequence — ashlr__edit/multi_edit diffs confirm each change.
5. Verify with ashlr__bash (typecheck/tests), not Read.
6. One ashlr__genome_propose at the end summarizing the full refactor.`;

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

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const cfg = safeReadJson(join(repoRoot, ".ashlr", `${SKILL_KEY}.json`));
    if (cfg !== null) return cfg.enabled === true;
  }

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
