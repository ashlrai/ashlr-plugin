/**
 * stats-isolation.test.ts — Per-session stats isolation.
 *
 * - Simulate two concurrent Claude Code sessions (different CLAUDE_SESSION_ID).
 * - Each records savings independently.
 * - Assert: A's session bucket does not include B's savings.
 * - Assert: B's session bucket does not include A's savings.
 * - Assert: lifetime is the sum of both.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeTempHome,
  SERVERS_DIR,
  sleep,
} from "../lib/harness.ts";

// ---------------------------------------------------------------------------
// recordSaving via subprocess so each call gets its own env
// ---------------------------------------------------------------------------

async function recordSavings(opts: {
  home: string;
  sessionId: string;
  toolName: string;
  count: number;
  tokensSaved: number;
}): Promise<void> {
  const { home, sessionId, toolName, count, tokensSaved } = opts;
  // Call recordSaving `count` times
  // recordSaving(rawBytes, compactBytes, toolName, opts)
  // rawBytes = tokensSaved * 4, compactBytes = 0 → saves tokensSaved tokens.
  const calls = Array.from({ length: count }, () =>
    `await recordSaving(${tokensSaved * 4}, 0, "${toolName}");`,
  ).join("\n");

  // bun eval is not a valid Bun command; write the script to a temp file instead.
  const scriptDir = mkdtempSync(join(tmpdir(), "ashlr-stat-iso-"));
  const scriptFile = join(scriptDir, "run.ts");
  writeFileSync(
    scriptFile,
    `import { recordSaving } from "${SERVERS_DIR}/_stats.ts";\n${calls}\n`,
  );
  const result = Bun.spawnSync(["bun", "run", scriptFile], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SESSION_ID: sessionId,
    },
  });
  rmSync(scriptDir, { recursive: true, force: true });

  if (result.exitCode !== 0) {
    throw new Error(
      `recordSavings failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

describe("stats-isolation", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("session A and B savings are isolated; lifetime is the sum", async () => {
    const tempHome  = makeTempHome();
    const sessionA  = "test-session-A-isolation";
    const sessionB  = "test-session-B-isolation";
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    const tokensA = 500;
    const tokensB = 300;
    const callsA  = 3;
    const callsB  = 2;

    // Run both sessions "concurrently" (sequential but independent subprocesses)
    await Promise.all([
      recordSavings({
        home: tempHome,
        sessionId: sessionA,
        toolName: "ashlr__read",
        count: callsA,
        tokensSaved: tokensA,
      }),
      recordSavings({
        home: tempHome,
        sessionId: sessionB,
        toolName: "ashlr__grep",
        count: callsB,
        tokensSaved: tokensB,
      }),
    ]);

    // Read final stats
    const { readLocalStats } = await import("../lib/harness.ts");
    const stats = readLocalStats(tempHome);
    expect(stats).not.toBeNull();

    // Session A bucket
    const bucketA = stats?.sessions?.[sessionA];
    expect(bucketA).toBeDefined();
    expect(bucketA!.calls).toBe(callsA);
    expect(bucketA!.tokensSaved).toBe(tokensA * callsA);
    // B's tool must not appear in A's byTool
    expect(bucketA!.byTool?.["ashlr__grep"]).toBeUndefined();

    // Session B bucket
    const bucketB = stats?.sessions?.[sessionB];
    expect(bucketB).toBeDefined();
    expect(bucketB!.calls).toBe(callsB);
    expect(bucketB!.tokensSaved).toBe(tokensB * callsB);
    // A's tool must not appear in B's byTool
    expect(bucketB!.byTool?.["ashlr__read"]).toBeUndefined();

    // Lifetime = sum of both
    const lifetime = stats?.lifetime;
    expect(lifetime).toBeDefined();
    expect(lifetime!.calls).toBe(callsA + callsB);
    expect(lifetime!.tokensSaved).toBe(tokensA * callsA + tokensB * callsB);
  }, 30_000);
});
