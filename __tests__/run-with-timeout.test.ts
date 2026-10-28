/**
 * Tests for servers/_run-with-timeout.ts
 *
 * Covers:
 *   - Happy path: command returns stdout, exit 0.
 *   - Stderr captured correctly.
 *   - Timeout: long-sleeping command returns timedOut:true within budget.
 *   - Process-group cleanup on timeout: spawning bash -c 'sleep 30 & sleep 30'
 *     then timing out - both grandchildren must be dead after the call returns.
 *   - Buffer cap: command producing >10 MB stdout is capped without OOM.
 *
 * Tests are skipped on Windows for the POSIX-specific process-group cases.
 */

import { beforeAll, describe, test, expect } from "bun:test";
import { runWithTimeout } from "../servers/_run-with-timeout";
import { pidAlive } from "../servers/_pid-alive";
import { timingBudgetMs } from "../scripts/timing-budget.ts";
import { warmUpSpawn } from "./_spawn-warmup";

const isWin = process.platform === "win32";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runWithTimeout", () => {
  // The first spawn in this file has never reported exit on macOS CI while later ones did; see _spawn-warmup.ts.
  beforeAll(async () => { await warmUpSpawn(); });

  test("happy path - stdout captured, exit 0", async () => {
    const result = await runWithTimeout({
      command: "echo",
      args: ["hello world"],
      // A loaded macOS runner has taken over 5 s to spawn `echo` (exit -1 on
      // timeout), so the budget scales on CI like the other timing tests.
      timeoutMs: timingBudgetMs(5_000),
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  }, timingBudgetMs(10_000));

  // Bun on macOS intermittently never reaps a spawned child: it exits as a
  // zombie and neither `exit` nor `close` is delivered (oven-sh/bun#34069).
  // The POSIX `sh` wrapper reports the real exit status on a stderr trailer,
  // so the run still settles quickly with the real code. This env hook drops
  // the process listeners to reproduce that failure shape deterministically.
  test.skipIf(isWin)("lost exit and close events still return the real exit code", async () => {
    process.env.ASHLR_RWT_SIMULATE_LOST_EXIT = "1";
    try {
      const started = Date.now();
      const result = await runWithTimeout({
        command: "sh",
        args: ["-c", "echo hi; exit 7"],
        timeoutMs: timingBudgetMs(5_000),
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout.trim()).toBe("hi");
      expect(result.timedOut).toBe(false);
      // The trailer is stripped from reported stderr.
      expect(result.stderr).not.toContain("__RWT_EXIT_");
      // Settled via the trailer + short drain, nowhere near the timeout or
      // the hard deadline the pre-fix code burned through.
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      delete process.env.ASHLR_RWT_SIMULATE_LOST_EXIT;
    }
  });

  // `close` waits for every stdio pipe to end. A child that exits while a
  // background process still holds its stdout used to keep the call open until
  // that process ended (or forever when `close` never fires, as seen on macOS
  // CI). The call now settles shortly after `exit` with the output so far.
  test.skipIf(isWin)("exit with a background process holding stdout open still settles", async () => {
    const started = Date.now();
    const result = await runWithTimeout({
      command: "sh",
      args: ["-c", "sleep 8 & echo hello"],
      timeoutMs: 20_000,
    });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // Well under the 8 s the background sleep holds the pipe.
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  // ---------------------------------------------------------------------------
  // Stderr captured
  // ---------------------------------------------------------------------------

  test("stderr captured", async () => {
    const result = await runWithTimeout({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32"
        ? ["/C", "echo error_text 1>&2"]
        : ["-c", "echo error_text >&2"],
      timeoutMs: 5_000,
    });
    expect(result.stderr).toContain("error_text");
    expect(result.stderr).not.toContain("__RWT_EXIT_");
    expect(result.timedOut).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Non-zero exit code
  // ---------------------------------------------------------------------------

  test("non-zero exit code returned without throw", async () => {
    const result = await runWithTimeout({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/C", "exit 42"] : ["-c", "exit 42"],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Timeout fires - returns timedOut:true
  // ---------------------------------------------------------------------------

  test("timeout - timedOut:true returned before wall-clock deadline", async () => {
    const start = Date.now();
    const result = await runWithTimeout({
      // Windows: use `ping` as a sleep substitute - `timeout.exe` requires an
      // interactive console and hangs waiting for a keypress in CI. `ping -n 31`
      // sends 31 ICMP requests to localhost, each ~1 s apart ≈ 30 s total.
      // `taskkill /F /T` terminates it cleanly without needing a console.
      command: process.platform === "win32" ? "ping" : "sleep",
      args: process.platform === "win32" ? ["-n", "31", "127.0.0.1"] : ["30"],
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // Windows: taskkill is async - the child's close event arrives after the
    // kill dispatch, so allow extra headroom on Windows CI runners.
    const wallClockBudget = process.platform === "win32" ? 8_000 : 5_000;
    expect(elapsed).toBeLessThan(wallClockBudget);
  }, 10_000);

  // ---------------------------------------------------------------------------
  // Process-group cleanup (POSIX only)
  //
  // Spawn bash -c 'sleep 30 & sleep 30' which forks two grandchildren.
  // After timeout, both must be dead (PIDs no longer exist in the process table).
  // ---------------------------------------------------------------------------

  test.skipIf(isWin)("process-group cleanup - grandchildren killed on timeout", async () => {
    // We need the PIDs of the grandchildren to verify they're dead.
    // Strategy: write the PIDs to a temp file before sleeping.
    const pidFile = `/tmp/ashlr-test-pids-${process.pid}.txt`;

    const result = await runWithTimeout({
      command: "bash",
      args: [
        "-c",
        // Fork two grandchildren; record their PIDs; then sleep 30s.
        `(sleep 30 & echo $! >> ${pidFile}; sleep 30 & echo $! >> ${pidFile}; wait)`,
      ],
      timeoutMs: 400,
    });

    expect(result.timedOut).toBe(true);

    // Give the OS a brief moment to fully reap the killed processes.
    await new Promise((r) => setTimeout(r, 200));

    // Read the recorded grandchild PIDs and verify they're dead.
    let grandchildPids: number[] = [];
    try {
      const { readFileSync, unlinkSync } = await import("fs");
      const raw = readFileSync(pidFile, "utf-8");
      unlinkSync(pidFile);
      grandchildPids = raw
        .trim()
        .split("\n")
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      // If no PIDs were written the grandchildren never started - test passes trivially.
    }

    for (const pid of grandchildPids) {
      // A killed orphan can linger as an unreaped zombie when PID 1 does not
      // reap (agent containers); pidAlive treats that as dead.
      expect(pidAlive(pid)).toBe(false);
    }
  }, 10_000);

  // ---------------------------------------------------------------------------
  // Buffer cap - command producing >10 MB stdout must not OOM
  // ---------------------------------------------------------------------------

  test("buffer cap - >10 MB stdout capped without OOM", async () => {
    // Generate ~12 MB via dd reading from /dev/zero and base64-encoding it.
    // On macOS and Linux `dd` + `base64` produces ASCII output safely.
    // We set a generous timeout since dd can be slow.
    const result = await runWithTimeout({
      command: "sh",
      args: ["-c", "dd if=/dev/zero bs=1024 count=12288 2>/dev/null | base64"],
      timeoutMs: 30_000,
    });
    // stdout must be capped at 10 MB.
    const tenMB = 10 * 1024 * 1024;
    expect(result.stdout.length).toBeLessThanOrEqual(tenMB);
    // Cap notice must appear in stderr.
    expect(result.stderr).toContain("capped at");
    expect(result.timedOut).toBe(false);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // stdin input passed to child
  // ---------------------------------------------------------------------------

  test("stdin input forwarded to child", async () => {
    const result = await runWithTimeout({
      command: "cat",
      args: [],
      input: "ping",
      timeoutMs: 5_000,
    });
    expect(result.stdout.trim()).toBe("ping");
    expect(result.exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Spawn error - invalid binary returns exitCode:-1, no throw
  // ---------------------------------------------------------------------------

  test("spawn error - invalid binary returns exitCode:-1 without throw", async () => {
    const result = await runWithTimeout({
      command: "/absolutely/nonexistent/binary",
      args: [],
      timeoutMs: 2_000,
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn error");
    expect(result.timedOut).toBe(false);
  });
});
