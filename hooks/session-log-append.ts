#!/usr/bin/env bun
/**
 * session-log-append.ts — Cross-platform replacement for session-log-append.sh.
 *
 * Appends one JSONL line per tool invocation to ~/.ashlr/session-log.jsonl.
 * Schema: { ts, agent, event, tool, cwd, session, input_size, output_size }
 *
 * Rules:
 *   - Never block the agent. All failures are silently swallowed.
 *   - Self-rotate: if the file passes 10 MB rename to .jsonl.1.
 *   - Honor ASHLR_SESSION_LOG=0 as a kill switch.
 */

import { mkdirSync, statSync, renameSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

if (process.env.ASHLR_SESSION_LOG === "0") process.exit(0);

const LOG_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
  ".ashlr",
);
const LOG_FILE = join(LOG_DIR, "session-log.jsonl");
const ROTATED = LOG_FILE + ".1";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function sizeOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return Buffer.byteLength(v, "utf-8");
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf-8");
  } catch {
    return 0;
  }
}

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    process.exit(0);
  }

  // Rotate if over cap.
  try {
    const st = statSync(LOG_FILE);
    if (st.size >= MAX_BYTES) {
      try {
        renameSync(LOG_FILE, ROTATED);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* file doesn't exist yet */
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  let tool = "unknown";
  let inSize = 0;
  let outSize = 0;
  try {
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.tool_name === "string") tool = p.tool_name;
      inSize = sizeOf(p?.tool_input);
      outSize = sizeOf(p?.tool_result ?? p?.tool_response);
    }
  } catch {
    /* use defaults */
  }

  const sessRaw = process.env.CLAUDE_SESSION_ID ?? "";
  let session = sessRaw;
  if (!session) {
    const seed = `${process.cwd()}:${process.pid}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    }
    session = `h${(h >>> 0).toString(16)}`;
  }

  const rec = {
    ts: new Date().toISOString(),
    agent: "claude-code",
    event: "tool_call",
    tool,
    cwd: process.cwd(),
    session,
    input_size: inSize,
    output_size: outSize,
  };

  try {
    appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }

  process.exit(0);
});
