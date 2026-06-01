#!/usr/bin/env bun
/**
 * sessionstart-genome-author.ts — SessionStart hook for the ashlr-genome-author skill.
 *
 * Injects the ashlr-genome-author ruleset as additionalContext when
 * ~/.ashlr/genome-author.json { "enabled": true } (or project-level .ashlr/genome-author.json).
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

const SKILL_KEY = "genome-author";

const RULESET = `[ashlr-genome-author] Genome proposal discipline active.
Call ashlr__genome_propose AFTER: new module added, schema change, auth/security change, routing change, or architectural decision.
Summary format: 2–5 sentences, past tense, ending with affected file paths.
Do NOT propose for: routine edits, typo fixes, test updates, mid-refactor (wait until stable), or more than once per logical change.
Use existing manifest section names where possible; introduce new names only for genuinely new architectural concepts.`;

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
