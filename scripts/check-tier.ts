#!/usr/bin/env bun
/**
 * check-tier.ts — print the active ashlr tier on stdout.
 *
 * Output: a single token, one of:
 *   "free"  — no pro-token, or token failed validation
 *   "pro"   — valid Pro plan
 *   "team"  — valid Team plan
 *
 * Reads `~/.ashlr/pro-token-cache.json` (24h cache, 7d offline grace).
 * Always exits 0 — callers can trust the output token.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface ProTokenCache {
  valid?: boolean;
  validatedAt?: string;
  plan?: "pro" | "team" | "free";
}

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function home(): string {
  return process.env.HOME ?? homedir();
}

function cachePath(): string {
  return join(home(), ".ashlr", "pro-token-cache.json");
}

function readCache(): ProTokenCache | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ProTokenCache;
  } catch {
    return null;
  }
}

function main(): void {
  const c = readCache();
  if (!c || c.valid !== true || !c.validatedAt) {
    process.stdout.write("free");
    return;
  }
  const age = Date.now() - new Date(c.validatedAt).getTime();
  if (age >= OFFLINE_GRACE_MS) {
    process.stdout.write("free");
    return;
  }
  const plan = c.plan;
  if (plan === "team") process.stdout.write("team");
  else if (plan === "pro") process.stdout.write("pro");
  else process.stdout.write("free");
}

main();
