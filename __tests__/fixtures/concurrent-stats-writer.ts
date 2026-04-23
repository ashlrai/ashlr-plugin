#!/usr/bin/env bun
/**
 * Child-process helper used by stats-sqlite-concurrent.test.ts.
 *
 * Usage:
 *   bun run __tests__/fixtures/concurrent-stats-writer.ts <dbPath> <sessionId> <iterations> <savedPerCall>
 *
 * Each invocation loops `iterations` times calling recordSaving, then exits.
 * The test spawns N of these in parallel to exercise cross-process writes to
 * the same SQLite file.
 */

import { recordSaving, _resetConnection } from "../../servers/_stats-sqlite";

const [, , dbPath, sessionId, iterRaw, savedRaw] = process.argv;

if (!dbPath || !sessionId || !iterRaw || !savedRaw) {
  process.stderr.write("missing argv\n");
  process.exit(2);
}

process.env.ASHLR_STATS_DB_PATH = dbPath;
const iterations = Number(iterRaw);
const savedPerCall = Number(savedRaw);

// We want a known `saved` value. recordSaving computes
// saved = ceil((raw - compact) / 4), so raw = savedPerCall*4, compact = 0
// yields exactly savedPerCall.
const rawBytes = savedPerCall * 4;
const compactBytes = 0;

async function main(): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await recordSaving(rawBytes, compactBytes, "ashlr__read", { sessionId });
  }
  _resetConnection();
}

main().then(() => process.exit(0)).catch((e) => {
  process.stderr.write(`child error: ${(e as Error).message}\n`);
  process.exit(1);
});
