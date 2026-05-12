#!/usr/bin/env bun
/**
 * sessionstart-brief.ts — SessionStart hook that injects the active
 * ashlr-brief level's ruleset into the session's additionalContext.
 *
 * Reads, in order of precedence:
 *   1. <repo-root>/.ashlr/brief.json   — project-level (Pro-enforced)
 *   2. ~/.ashlr/brief.json             — user-level
 *
 * Active levels: "lite" | "standard" | "concise"
 * Inactive level: "off" (or missing file) — emits no additionalContext.
 *
 * Hook contract (SessionStart):
 *   stdout → { hookSpecificOutput: { hookEventName: "SessionStart",
 *                                    additionalContext?: string } }
 *
 * Design rules:
 *   - Never throw — passes through silently on any error.
 *   - The additionalContext is short (<500 bytes) so it doesn't bloat
 *     every session that has brief enabled.
 *   - Always exits 0.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { noteHookError } from "./_hook-errors";

interface BriefConfig {
  level?: "off" | "lite" | "standard" | "concise";
  source?: "user" | "project";
  setAt?: string;
  writtenBy?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext?: string;
  };
}

function safeReadJson(path: string): BriefConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BriefConfig;
  } catch (e) {
    noteHookError("sessionstart-brief", `parse:${path}`, e);
    return null;
  }
}

/** Find the repo root by walking up from cwd looking for .git or package.json. */
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

function home(): string {
  return process.env.HOME ?? homedir();
}

/** Resolve the active level: project file wins over user file when present. */
export function resolveActiveLevel(opts?: { homeDir?: string; cwd?: string }): {
  level: "off" | "lite" | "standard" | "concise";
  source: "user" | "project" | "none";
} {
  const h = opts?.homeDir ?? home();
  const cwd = opts?.cwd ?? process.cwd();

  // 1. Project file (when in a repo)
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const projectCfg = safeReadJson(join(repoRoot, ".ashlr", "brief.json"));
    if (projectCfg && projectCfg.level && projectCfg.level !== "off") {
      return { level: projectCfg.level, source: "project" };
    }
  }

  // 2. User file
  const userCfg = safeReadJson(join(h, ".ashlr", "brief.json"));
  if (userCfg && userCfg.level && userCfg.level !== "off") {
    return { level: userCfg.level, source: "user" };
  }

  // 3. Eco-mode fallback — when ASHLR_ECO=1 and no explicit brief level, default
  //    to "standard". This is the integration point with /ashlr-eco-mode.
  if (process.env["ASHLR_ECO"] === "1" && (!userCfg || userCfg.level == null || userCfg.level === "off")) {
    return { level: "standard", source: "user" };
  }

  return { level: "off", source: "none" };
}

const RULESETS: Record<"lite" | "standard" | "concise", string> = {
  lite:
`[ashlr-brief: lite] Trim filler from prose. Drop "just", "really", "basically", "actually", "simply", "in order to" (use "to"), "due to the fact that" (use "because"). Drop self-narration ("Let me look at...", "I'll now..."). Keep: full grammar, articles, complete sentences, all explanations the user asked for, code blocks, error messages, destructive-action confirmations.`,
  standard:
`[ashlr-brief: standard] Drop filler AND padding. Cut transition phrases ("Now that we have X, let's...", "As you can see"), restating-the-question preambles, and "Here's what I did:" lists when the diff already shows it. Replace verbose constructions with short ones. Keep: complete sentences, articles, code blocks untouched, errors verbatim, destructive-action confirmations in full grammar.`,
  concise:
`[ashlr-brief: concise] Drop filler, padding, and most articles. Sentence fragments OK when meaning is clear. Arrow notation for causality ("X → Y"). Common abbreviations OK in prose only (db, auth, cfg, req, res, fn, ctx). NEVER abbreviate identifiers, file paths, function names, or render error messages compressed. Keep: code blocks untouched, destructive-action confirmations in full grammar, security findings in full grammar, multi-step migrations in full grammar.`,
};

const COMMON_RULES =
`Auto-clarity exceptions (always restore full grammar): destructive actions (rm -rf, git reset --hard, force-push, DROP TABLE, deleting branches), security findings (credentials, secrets, vulnerabilities), multi-step migrations, error messages and stack traces, code blocks and diffs, file:line citations.`;

export function buildAdditionalContext(level: "off" | "lite" | "standard" | "concise", source: "user" | "project" | "none"): string {
  if (level === "off") return "";
  const ruleset = RULESETS[level];
  const sourceLabel = source === "project" ? "project-level (.ashlr/brief.json)" : "user-level (~/.ashlr/brief.json)";
  return `${ruleset}\n\n${COMMON_RULES}\n\nActive source: ${sourceLabel}. Toggle via /ashlr-brief off.`;
}

async function main(): Promise<void> {
  try {
    const { level, source } = resolveActiveLevel();
    const out: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        ...(level !== "off" ? { additionalContext: buildAdditionalContext(level, source) } : {}),
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    noteHookError("sessionstart-brief", "main", e);
    // Pass-through on any error.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart" } }));
  }
}

if (import.meta.main) {
  void main();
}
