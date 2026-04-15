#!/usr/bin/env bun
/**
 * commit-attribution.ts
 *
 * Claude Code PreToolUse hook (matched on Bash). Reads the tool call JSON
 * from stdin; if the command is a `git commit -m/--message=` invocation,
 * append an `Assisted-By: ashlr-plugin` trailer so commits made through
 * Claude Code are honestly attributed.
 *
 * Pure local — no telemetry, no network. Honors `~/.claude/settings.json`
 * `ashlr.attribution` (default true). Designed to never block a commit:
 * any parsing failure falls through to a pass-through.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const TRAILER = "Assisted-By: ashlr-plugin <https://plugin.ashlr.ai>";

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface HookResult {
  /** The (possibly rewritten) command to run, or null to leave it alone. */
  rewrittenCommand: string | null;
  /** True iff we modified the original command. */
  modified: boolean;
}

export function isAttributionEnabled(settingsPath = join(homedir(), ".claude", "settings.json")): boolean {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    const ashlr = parsed?.ashlr;
    if (ashlr && typeof ashlr === "object" && "attribution" in ashlr) {
      return ashlr.attribution !== false;
    }
    return true;
  } catch {
    // Missing file / malformed settings → default ON.
    return true;
  }
}

export function alreadyAttributed(message: string): boolean {
  return /Assisted-By:|Co-Authored-By:/i.test(message);
}

/**
 * Rewrite a single quoted message (preserving the original quote style) by
 * appending the trailer, unless already attributed.
 */
function appendToMessage(message: string): string {
  if (alreadyAttributed(message)) return message;
  // Two blank lines between body and trailer block per git convention.
  // If the message already ends with one newline, we still want a blank line.
  const sep = message.endsWith("\n\n") ? "" : message.endsWith("\n") ? "\n" : "\n\n";
  return message + sep + TRAILER;
}

/**
 * Find a `-m`/`--message=` argument in a `git commit` command and rewrite
 * the message in-place. Returns the rewritten command, or null if we can't
 * confidently rewrite (in which case the caller should pass through).
 *
 * Handles:
 *   git commit -m "msg"
 *   git commit -m 'msg'
 *   git commit --message="msg"
 *   git commit --message='msg'
 *
 * Punts on:
 *   git commit               (opens editor — nothing to rewrite)
 *   git commit -F file       (message lives in a file; rewriting would
 *                             require disk I/O on a user-owned path)
 *   git commit -m msg        (unquoted — ambiguous tokenization)
 */
export function rewriteGitCommit(command: string): HookResult {
  const trimmed = command.trim();

  // Cheap pre-check: must contain `git commit` as a recognizable token.
  // Allow leading env vars / pipes by just searching.
  if (!/\bgit\s+commit\b/.test(trimmed)) {
    return { rewrittenCommand: null, modified: false };
  }

  // -m "..." / -m '...'
  // Use a lazy match across the whole string so escaped quotes inside
  // double-quoted strings (\") are tolerated.
  const reDouble = /(\bgit\s+commit\b[^]*?)(-m\s+)"((?:\\.|[^"\\])*)"/;
  const reSingle = /(\bgit\s+commit\b[^]*?)(-m\s+)'((?:[^'\\]|\\.)*)'/;
  const reLongDouble = /(\bgit\s+commit\b[^]*?)(--message=)"((?:\\.|[^"\\])*)"/;
  const reLongSingle = /(\bgit\s+commit\b[^]*?)(--message=)'((?:[^'\\]|\\.)*)'/;

  for (const [re, quote] of [
    [reDouble, '"'],
    [reSingle, "'"],
    [reLongDouble, '"'],
    [reLongSingle, "'"],
  ] as const) {
    const m = trimmed.match(re);
    if (!m) continue;
    const [, prefix, flag, body] = m;
    // Decode escapes for the duplicate check, but re-emit body literally
    // and just append the trailer to the literal body.
    const decoded = quote === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body.replace(/\\(['\\])/g, "$1");
    if (alreadyAttributed(decoded)) {
      return { rewrittenCommand: null, modified: false };
    }
    // Append the trailer inside the quotes. Use literal newlines — both
    // bash double and single quotes preserve them.
    const newBody = body + (body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n") + TRAILER;
    const matched = m[0];
    const replacement = `${prefix}${flag}${quote}${newBody}${quote}`;
    const rewritten = trimmed.replace(matched, replacement);
    return { rewrittenCommand: rewritten, modified: true };
  }

  // Fell through — bare `git commit`, `-F`, `-m unquoted`, etc. Pass through.
  return { rewrittenCommand: null, modified: false };
}

/** Pass-through hook output: tells Claude Code to run the command unchanged. */
function passThrough(): string {
  return JSON.stringify({});
}

/**
 * Build the PreToolUse hook output that rewrites the Bash command.
 * Claude Code's PreToolUse hook supports `hookSpecificOutput` with an
 * updated `tool_input` shape; we emit that so the agent runs the rewritten
 * git commit instead of the original.
 */
function rewriteOutput(newCommand: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: newCommand },
    },
  });
}

export function processHookInput(stdin: string, settingsPath?: string): string {
  let input: HookInput;
  try {
    input = JSON.parse(stdin);
  } catch {
    return passThrough();
  }
  if (input?.tool_name !== "Bash") return passThrough();
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return passThrough();

  if (!isAttributionEnabled(settingsPath)) return passThrough();

  const { rewrittenCommand, modified } = rewriteGitCommit(command);
  if (!modified || !rewrittenCommand) return passThrough();
  return rewriteOutput(rewrittenCommand);
}

// Entry point — only run when executed as a script, not when imported by tests.
if (import.meta.main) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => {
    const stdin = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(processHookInput(stdin));
    process.exit(0);
  });
  // If stdin is closed (no data piped), exit pass-through immediately.
  process.stdin.on("error", () => {
    process.stdout.write(passThrough());
    process.exit(0);
  });
}
