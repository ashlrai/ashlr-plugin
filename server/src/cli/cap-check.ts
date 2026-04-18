#!/usr/bin/env bun
/**
 * cap-check.ts — Debug utility for the LLM summarizer daily cap.
 *
 * Usage:
 *   bun run src/cli/cap-check.ts <user-token>
 *
 * Prints today's call count, total cost, and remaining budget for the user
 * associated with the given API token. Exits 1 if the token is invalid.
 */

import { getUserByToken, getDailyUsage } from "../db.js";

async function main(): Promise<void> {
  const token = process.argv[2]?.trim();

  if (!token) {
    console.error("Usage: bun run src/cli/cap-check.ts <user-token>");
    process.exit(1);
  }

  const user = getUserByToken(token);
  if (!user) {
    console.error("Error: invalid or expired token");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const usage = getDailyUsage(user.id, today);

  const calls     = usage?.summarize_calls ?? 0;
  const cost      = usage?.total_cost      ?? 0;
  const callsLeft = Math.max(0, 1000 - calls);
  const costLeft  = Math.max(0, 1.00 - cost);

  console.log(`User:            ${user.id}`);
  console.log(`Email:           ${user.email}`);
  console.log(`Date:            ${today}`);
  console.log(`Summarize calls: ${calls} / 1000`);
  console.log(`Cost today:      $${cost.toFixed(6)} / $1.00`);
  console.log(`Remaining:       ${callsLeft} calls, $${costLeft.toFixed(6)}`);
  console.log(`Cap status:      ${callsLeft > 0 && costLeft > 0 ? "OK" : "BLOCKED"}`);
}

await main();
