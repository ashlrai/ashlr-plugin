#!/usr/bin/env bun
/**
 * sessionstart-efficient.ts — SessionStart hook for the ashlr-efficient output style.
 *
 * Injects the ashlr-efficient ruleset as additionalContext when
 * ~/.ashlr/efficient.json { "enabled": true } (or project-level .ashlr/efficient.json).
 *
 * When BOTH ashlr-brief and ashlr-efficient are active, emits a merged block
 * noting that both rulesets apply.
 *
 * Contract: never throws, always exits 0.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { noteHookError } from "./_hook-errors";
import { resolveActiveLevel } from "./sessionstart-brief";

interface SkillConfig {
  enabled?: boolean;
}

interface BriefConfig {
  level?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext?: string;
  };
}

const SKILL_KEY = "efficient";

const EFFICIENT_RULESET = `[ashlr-efficient] Output structure rules active.
1. Inverted pyramid: lead with the answer, then context/explanation.
2. Inline code for all identifiers, paths, CLI commands, and config keys.
3. Tables for 3+ item comparisons (not bulleted prose lists).
4. No transitional filler: drop "Now that we have X", "As mentioned above", "Moving on to", "Let's now", "With that in mind".
5. file:line citations instead of quoted blocks (quote only when exact text is load-bearing).`;

const COMBINED_RULESET = `[ashlr-brief + ashlr-efficient] Both output-shaping rulesets are active simultaneously.
ashlr-brief: reduces prose volume (drops filler words, padding, restating-the-question preambles).
ashlr-efficient: reshapes structure (answer-first, inline code for identifiers, tables for 3+ comparisons, no transitional filler, file:line citations).
Auto-clarity exceptions (both suspended): destructive actions, security findings, error messages/stack traces, multi-step migrations, code blocks/diffs.`;

function safeReadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
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
    const cfg = safeReadJson<SkillConfig>(join(repoRoot, ".ashlr", `${SKILL_KEY}.json`));
    if (cfg !== null) return cfg.enabled === true;
  }

  const userCfg = safeReadJson<SkillConfig>(join(h, ".ashlr", `${SKILL_KEY}.json`));
  return userCfg?.enabled === true;
}

/** Returns the context string. Detects if ashlr-brief is also active and merges. */
export function buildAdditionalContext(opts?: { homeDir?: string; cwd?: string }): string {
  const { level } = resolveActiveLevel(opts);
  const briefActive = level !== "off";
  return briefActive ? COMBINED_RULESET : EFFICIENT_RULESET;
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
