#!/usr/bin/env bun
/**
 * cap-check.ts — Debug utility for the LLM summarizer daily cap.
 *
 * Usage:
 *   bun run src/cli/cap-check.ts            (token from stdin: paste, or pipe it)
 *
 * Prints today's call count, total cost, and remaining budget for the user
 * associated with the given API token. Exits 1 if the token is invalid.
 *
 * The token is read from stdin (hidden at a terminal) so it never lands in
 * argv, where other local users see it in `ps`, or in shell history. A token
 * given as an argument still works but prints a warning.
 */

import { getUserByToken, getDailyUsage } from "../db.js";

/** One line from stdin; not echoed at a terminal. Never printed. */
async function readTokenFromStdin(): Promise<string> {
  const stdin = process.stdin;
  const tty = stdin.isTTY === true && typeof stdin.setRawMode === "function";
  if (tty) process.stderr.write("Paste the user API token, then press Enter (input is hidden): ");
  return new Promise((resolve) => {
    let buf = "";
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", finish);
      if (tty) {
        stdin.setRawMode(false);
        process.stderr.write("\n");
      }
      stdin.pause();
      resolve(buf.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\n" || ch === "\r") return finish();
        if (tty && ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (tty && (ch === "\u007f" || ch === "\b")) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    if (tty) stdin.setRawMode(true);
    stdin.setEncoding("utf-8");
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.resume();
  });
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.trim();
  if (arg) {
    console.error(
      "warning: a token passed as an argument is visible to other local users (ps) and is kept in shell history. " +
      "Next time run `bun run src/cli/cap-check.ts` and paste or pipe the token on stdin.",
    );
  }
  const token = arg || (await readTokenFromStdin());

  if (!token) {
    console.error("Usage: bun run src/cli/cap-check.ts   (paste or pipe the user API token on stdin)");
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
