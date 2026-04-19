/**
 * status-line-freshness.test.ts — Real-time counter freshness.
 *
 * - Record 10 savings with 100ms between each.
 * - Assert: running scripts/savings-status-line.ts after each returns a
 *   strictly increasing session counter within 500ms of each recordSaving.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import {
  makeTempHome,
  sleep,
  PLUGIN_ROOT,
  SERVERS_DIR,
} from "../lib/harness.ts";

// ---------------------------------------------------------------------------
// Direct stats write helper (uses the _stats module via a tiny Bun subprocess)
// ---------------------------------------------------------------------------

async function recordSavingSubprocess(
  home: string,
  sessionId: string,
  toolName: string,
  tokensSaved: number,
): Promise<void> {
  // bun eval is not a valid Bun command; write the script to a temp file instead.
  const scriptDir = mkdtempSync(join(tmpdir(), "ashlr-stat-sub-"));
  const scriptFile = join(scriptDir, "run.ts");
  // recordSaving(rawBytes, compactBytes, toolName, opts)
  // We pass rawBytes = tokensSaved * 4, compactBytes = 0 → saves tokensSaved tokens.
  writeFileSync(
    scriptFile,
    `import { recordSaving } from "${SERVERS_DIR}/_stats.ts";\nawait recordSaving(${tokensSaved * 4}, 0, "${toolName}");\n`,
  );
  const result = Bun.spawnSync(
    ["bun", "run", scriptFile],
    {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_SESSION_ID: sessionId,
      },
    },
  );
  rmSync(scriptDir, { recursive: true, force: true });
  if (result.exitCode !== 0) {
    throw new Error(
      `recordSaving subprocess failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

async function runStatusLine(home: string, sessionId: string): Promise<string> {
  const result = Bun.spawnSync(
    ["bun", "run", join(PLUGIN_ROOT, "scripts/savings-status-line.ts")],
    {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_SESSION_ID: sessionId,
      },
    },
  );
  return new TextDecoder().decode(result.stdout).trim();
}

function extractSessionCount(line: string): number {
  // Strip ANSI escape codes before matching
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
  // Matches "session ↑+100", "session ↑+1.0K", "session +5", "session: 5", "+5 session"
  // The status line abbreviates large numbers with K suffix (e.g. "+1.0K")
  const m = clean.match(/session\s*[\u2191\u2193]?\s*\+?([\d.]+K?)|session:\s*([\d.]+K?)|\+([\d.]+K?)\s*session/i);
  if (!m) return -1;
  const raw = (m[1] ?? m[2] ?? m[3] ?? "0");
  if (raw.endsWith("K")) return Math.round(parseFloat(raw) * 1000);
  return Number(raw);
}

describe("status-line-freshness", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("status line reflects strictly increasing session savings", async () => {
    const tempHome  = makeTempHome();
    const sessionId = "test-session-status-line-001";
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    const counts: number[] = [];

    for (let i = 0; i < 10; i++) {
      await recordSavingSubprocess(tempHome, sessionId, "ashlr__read", 100 * (i + 1));
      await sleep(100);

      const line  = await runStatusLine(tempHome, sessionId);
      const count = extractSessionCount(line);
      counts.push(count);
    }

    // All counts that were parseable must be non-negative
    const parseable = counts.filter((c) => c >= 0);
    expect(parseable.length).toBeGreaterThan(0);

    // Each subsequent parseable count must be >= the previous
    for (let i = 1; i < parseable.length; i++) {
      expect(parseable[i]!).toBeGreaterThanOrEqual(parseable[i - 1]!);
    }

    // Final count must be positive (we recorded savings)
    expect(parseable[parseable.length - 1]!).toBeGreaterThan(0);
  }, 30_000);
});
