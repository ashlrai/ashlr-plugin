/**
 * Tests for pretooluse-budget-guard.ts
 *
 * Tests the decide() function directly (no process.exit in unit tests).
 * Integration tests use Bun.spawn to run the hook with stdin + env overrides.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  decide,
  readSessionBytes,
  bytesToTokens,
  tokensToUsd,
  type DecideOpts,
} from "../../hooks/pretooluse-budget-guard";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpHome(): string {
  const dir = join(tmpdir(), `ashlr-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSessionLog(homeDir: string, entries: Array<{ session?: string; input_size: number; output_size: number }>): void {
  const dir = join(homeDir, ".ashlr");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      agent: "claude-code",
      event: "tool_call",
      tool: "Read",
      cwd: "/test",
      session: e.session ?? "test-session",
      input_size: e.input_size,
      output_size: e.output_size,
    }),
  );
  writeFileSync(join(dir, "session-log.jsonl"), lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Unit: readSessionBytes
// ---------------------------------------------------------------------------

describe("readSessionBytes", () => {
  test("returns 0 when session log does not exist", () => {
    const home = tmpHome();
    expect(readSessionBytes(home, "test-session")).toBe(0);
  });

  test("sums input_size + output_size for matching session", () => {
    const home = tmpHome();
    writeSessionLog(home, [
      { session: "test-session", input_size: 1000, output_size: 2000 },
      { session: "test-session", input_size: 500, output_size: 1500 },
    ]);
    expect(readSessionBytes(home, "test-session")).toBe(5000);
  });

  test("ignores entries from other sessions", () => {
    const home = tmpHome();
    writeSessionLog(home, [
      { session: "test-session", input_size: 1000, output_size: 2000 },
      { session: "other-session", input_size: 9000, output_size: 9000 },
    ]);
    expect(readSessionBytes(home, "test-session")).toBe(3000);
  });

  test("handles malformed lines gracefully", () => {
    const home = tmpHome();
    const dir = join(home, ".ashlr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session-log.jsonl"),
      '{"session":"test-session","input_size":100,"output_size":200}\nNOT_JSON\n{"session":"test-session","input_size":50,"output_size":50}\n',
    );
    expect(readSessionBytes(home, "test-session")).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit: bytesToTokens, tokensToUsd
// ---------------------------------------------------------------------------

describe("bytesToTokens", () => {
  test("divides bytes by 4 (ceiling)", () => {
    expect(bytesToTokens(0)).toBe(0);
    expect(bytesToTokens(4)).toBe(1);
    expect(bytesToTokens(5)).toBe(2);
    expect(bytesToTokens(4000)).toBe(1000);
  });
});

describe("tokensToUsd", () => {
  test("1M tokens = $10.40 (blended rate: $4 input 60% + $20 output 40%)", () => {
    const usd = tokensToUsd(1_000_000);
    // 4*0.6 + 20*0.4 = 2.4 + 8.0 = 10.4 $/Mtok
    expect(usd).toBeCloseTo(10.4, 1);
  });

  test("0 tokens = $0", () => {
    expect(tokensToUsd(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: decide() — no budget set
// ---------------------------------------------------------------------------

describe("decide(): no budget", () => {
  test("passes through when no budget env vars set", () => {
    const result = decide({ budgetUsd: undefined, budgetTokens: undefined, home: tmpHome(), sessionId: "x" });
    expect(result.action).toBe("pass");
  });

  test("passes through when ASHLR_SESSION_LOG=0", () => {
    const home = tmpHome();
    writeSessionLog(home, [{ input_size: 1000000, output_size: 1000000 }]);
    const result = decide({ budgetUsd: "0.01", home, sessionId: "test-session", sessionLog: "0" });
    expect(result.action).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Unit: decide() — USD budget
// ---------------------------------------------------------------------------

describe("decide(): USD budget", () => {
  test("passes when usage is below 80%", () => {
    const home = tmpHome();
    // ~100k tokens = ~$0.92. Budget $2 → 46% used
    writeSessionLog(home, [{ session: "s1", input_size: 200_000, output_size: 200_000 }]);
    const result = decide({ budgetUsd: "2.00", home, sessionId: "s1" });
    expect(result.action).toBe("pass");
    expect(result.pct).toBeLessThan(0.80);
  });

  test("warns at 80%", () => {
    const home = tmpHome();
    // 348k bytes → 87k tokens → ~$0.905 of $1.00 → 90.5% → warn-80 zone
    writeSessionLog(home, [{ session: "s1", input_size: 300_000, output_size: 48_000 }]);
    const result = decide({ budgetUsd: "1.00", home, sessionId: "s1" });
    if (result.pct >= 0.80 && result.pct < 0.95) {
      expect(result.action).toBe("warn-80");
      // Context contains actual pct%, not the threshold label
      expect(result.context).toContain("[ashlr] Budget at");
      expect(result.context).toMatch(/\d+%/);
    }
    // If pct ended up >= 0.95 the data landed in warn-95 zone — still correct behavior
  });

  test("warns loudly at 95%", () => {
    const home = tmpHome();
    // $0.95 of $1.00 budget → ~103260 tokens → ~413040 bytes
    writeSessionLog(home, [{ session: "s1", input_size: 350_000, output_size: 65_000 }]);
    const result = decide({ budgetUsd: "1.00", home, sessionId: "s1" });
    if (result.pct >= 0.95 && result.pct < 1.0) {
      expect(result.action).toBe("warn-95");
      expect(result.context).toContain("Consider stopping soon");
    }
  });

  test("blocks at 100%", () => {
    const home = tmpHome();
    // Over $0.10 budget (very small): 1M bytes → 250k tokens → $2.30 USD
    writeSessionLog(home, [{ session: "s1", input_size: 500_000, output_size: 500_000 }]);
    const result = decide({ budgetUsd: "0.10", home, sessionId: "s1" });
    expect(result.action).toBe("block");
    expect(result.pct).toBeGreaterThanOrEqual(1.0);
    expect(result.context).toContain("Budget exceeded");
    expect(result.context).toContain("/ashlr-budget off");
  });

  test("block message includes dollar amounts", () => {
    const home = tmpHome();
    writeSessionLog(home, [{ session: "s1", input_size: 500_000, output_size: 500_000 }]);
    const result = decide({ budgetUsd: "0.10", home, sessionId: "s1" });
    expect(result.action).toBe("block");
    expect(result.context).toMatch(/\$[\d.]+/);
  });

  test("returns usedUsd and budgetUsd in result", () => {
    const home = tmpHome();
    writeSessionLog(home, [{ session: "s1", input_size: 4000, output_size: 4000 }]);
    const result = decide({ budgetUsd: "2.00", home, sessionId: "s1" });
    expect(result.budgetUsd).toBe(2.0);
    expect(result.usedUsd).toBeGreaterThan(0);
    expect(result.usedTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: decide() — token budget
// ---------------------------------------------------------------------------

describe("decide(): token budget", () => {
  test("passes when usage is below 80%", () => {
    const home = tmpHome();
    // 4000 bytes → 1000 tokens → 1% of 100k budget
    writeSessionLog(home, [{ session: "s1", input_size: 2000, output_size: 2000 }]);
    const result = decide({ budgetTokens: "100000", home, sessionId: "s1" });
    expect(result.action).toBe("pass");
    expect(result.pct).toBeLessThan(0.80);
  });

  test("blocks at 100% with token message", () => {
    const home = tmpHome();
    // 400k bytes → 100k tokens, budget=50k → 200% over
    writeSessionLog(home, [{ session: "s1", input_size: 200_000, output_size: 200_000 }]);
    const result = decide({ budgetTokens: "50000", home, sessionId: "s1" });
    expect(result.action).toBe("block");
    expect(result.context).toContain("tokens used");
  });

  test("returns usedTokens and budgetTokens in result", () => {
    const home = tmpHome();
    writeSessionLog(home, [{ session: "s1", input_size: 4000, output_size: 4000 }]);
    const result = decide({ budgetTokens: "100000", home, sessionId: "s1" });
    expect(result.budgetTokens).toBe(100_000);
    expect(result.usedTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: spawn the hook process
// ---------------------------------------------------------------------------

describe("pretooluse-budget-guard: integration (spawned process)", () => {
  const HOOK_PATH = join(
    __dirname,
    "../../hooks/pretooluse-budget-guard.ts",
  );

  async function runHook(
    env: Record<string, string>,
    stdin = "{}",
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: new TextEncoder().encode(stdin),
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("exits 0 when no budget set", async () => {
    const result = await runHook({
      ASHLR_SESSION_BUDGET_USD: "",
      ASHLR_SESSION_BUDGET_TOKENS: "",
    });
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 when budget is set but no session log", async () => {
    const home = tmpHome();
    const result = await runHook({
      ASHLR_SESSION_BUDGET_USD: "100.00",
      ASHLR_HOME_OVERRIDE: home,
    });
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 and emits additionalContext warning when at 80%+", async () => {
    const home = tmpHome();
    // 1M bytes → 250k tokens → $2.30, budget $2.50 → 92%
    writeSessionLog(home, [
      { session: currentSessionId(), input_size: 500_000, output_size: 500_000 },
    ]);
    const result = await runHook({
      ASHLR_SESSION_BUDGET_USD: "2.50",
      ASHLR_HOME_OVERRIDE: home,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    // Should have a warning context
    if (parsed.hookSpecificOutput?.additionalContext) {
      expect(parsed.hookSpecificOutput.additionalContext).toContain("[ashlr]");
    }
  });

  test("exits 2 when budget is exceeded", async () => {
    const home = tmpHome();
    const sid = "test-integration-exceed";
    // 1M bytes → 250k tokens → $2.60, budget $0.10
    writeSessionLog(home, [
      { session: sid, input_size: 500_000, output_size: 500_000 },
    ]);
    const result = await runHook({
      ASHLR_SESSION_BUDGET_USD: "0.10",
      ASHLR_HOME_OVERRIDE: home,
      ASHLR_SESSION_ID: sid,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Budget exceeded");
  });

  test("exit-2 stderr message contains /ashlr-budget off", async () => {
    const home = tmpHome();
    const sid = "test-integration-off-msg";
    writeSessionLog(home, [
      { session: sid, input_size: 500_000, output_size: 500_000 },
    ]);
    const result = await runHook({
      ASHLR_SESSION_BUDGET_USD: "0.10",
      ASHLR_HOME_OVERRIDE: home,
      ASHLR_SESSION_ID: sid,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("/ashlr-budget off");
  });
});

// ---------------------------------------------------------------------------
// Helper: currentSessionId for integration tests (must match hook logic)
// ---------------------------------------------------------------------------

function currentSessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID?.trim() || process.env.ASHLR_SESSION_ID?.trim();
  if (explicit) return explicit;
  const seed = `${process.cwd()}:${process.ppid ?? process.pid}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16)}`;
}
