/**
 * _run-with-timeout.ts — async subprocess wrapper with process-group cleanup.
 *
 * Mirrors the bash-server.ts `runRaw` pattern (spawn + on('close') + accumulator
 * buffers + signal handling) but generalises it into a reusable utility for the
 * server hot-paths that previously called spawnSync.
 *
 * Key behaviours:
 *   - POSIX: `detached: true` creates a process group; on timeout we SIGKILL
 *     the whole group (`-pid`) so grandchild processes don't leak.
 *   - Windows: `taskkill /T /F /PID` cascades through the process tree.
 *   - SIGTERM first, 250 ms grace, then SIGKILL.
 *   - Never throws on subprocess error — returns `exitCode: -1` with the error
 *     surfaced in `stderr`.
 *   - Always settles. `close` is the normal path, but it waits for every stdio
 *     pipe to end and has been seen not to fire at all (ashlr-plugin main run
 *     39195707592, macOS: a `echo` call outlived its own 5 s timeout and hit the
 *     15 s test timeout). So `exit` starts a short drain window after which we
 *     resolve with what was collected, and a hard deadline slightly past the
 *     kill grace resolves a run that never reports `exit` or `close`.
 *   - Stdout and stderr are each capped at 10 MB to prevent OOM on runaway
 *     output; excess bytes are silently dropped (the cap notice appears in
 *     stderr so callers can detect truncation).
 */

import { spawn } from "child_process";

/** After `exit`, how long to wait for `close` (pipes drained) before settling. */
const EXIT_DRAIN_MS = 1_000;
/** Past the timeout and the 250 ms SIGKILL grace, how long before we give up. */
const HARD_DEADLINE_SLACK_MS = 2_000;

/** Maximum bytes buffered per stream before we stop accumulating. */
const STREAM_CAP = 10 * 1024 * 1024; // 10 MB

export interface RunWithTimeoutOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Optional stdin to feed the child process (UTF-8 string). */
  input?: string;
  /**
   * Optional abort signal. Aborting kills the process group exactly like a
   * timeout does (and reports `timedOut: true`). Callers that stop waiting
   * early, such as a total cap racing several probes, use this so the child
   * and its descendants do not outlive the caller.
   */
  signal?: AbortSignal;
}

export interface RunWithTimeoutResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or -1 on spawn error. */
  exitCode: number;
  timedOut: boolean;
}

/**
 * Spawn `command args` and collect stdout/stderr, killing the process (group)
 * after `timeoutMs` milliseconds. Returns a resolved Promise — never rejects.
 */
export function runWithTimeout(opts: RunWithTimeoutOptions): Promise<RunWithTimeoutResult> {
  return new Promise((resolveP) => {
    const isWin = process.platform === "win32";

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      // POSIX: own process group so timeout can kill the whole tree.
      // Windows: detached:true spawns a new console window, so we skip it.
      detached: !isWin,
    });

    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;

    child.stdout?.on("data", (b: Buffer) => {
      if (stdout.length >= STREAM_CAP) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          stderr += `\n[_run-with-timeout: stdout capped at ${STREAM_CAP} bytes]\n`;
        }
        return;
      }
      const remaining = STREAM_CAP - stdout.length;
      if (b.length <= remaining) {
        stdout += b.toString("utf-8");
      } else {
        // Truncate the chunk so total stays at exactly STREAM_CAP.
        stdout += b.subarray(0, remaining).toString("utf-8");
        if (!stdoutCapped) {
          stdoutCapped = true;
          stderr += `\n[_run-with-timeout: stdout capped at ${STREAM_CAP} bytes]\n`;
        }
      }
    });

    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length >= STREAM_CAP) {
        if (!stderrCapped) {
          stderrCapped = true;
          stderr += `\n[_run-with-timeout: stderr capped at ${STREAM_CAP} bytes]\n`;
        }
        return;
      }
      const remaining = STREAM_CAP - stderr.length;
      if (b.length <= remaining) {
        stderr += b.toString("utf-8");
      } else {
        stderr += b.subarray(0, remaining).toString("utf-8");
        if (!stderrCapped) {
          stderrCapped = true;
          stderr += `\n[_run-with-timeout: stderr capped at ${STREAM_CAP} bytes]\n`;
        }
      }
    });

    // Write stdin if provided, then close it.
    if (opts.input !== undefined && child.stdin) {
      try {
        child.stdin.write(opts.input, "utf-8");
        child.stdin.end();
      } catch {
        // stdin may already be closed if the child died immediately.
      }
    }

    /** Kill the process tree and set timedOut flag. */
    let killed = false;
    function killTree(): void {
      if (killed) return;
      killed = true;
      timedOut = true;
      if (isWin) {
        // taskkill /T cascades through child processes on Windows.
        if (child.pid != null) {
          spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
            stdio: "ignore",
          }).on("error", () => {
            // Ignore — process may already be gone.
          });
        } else {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }
      } else if (child.pid != null) {
        // SIGTERM first; escalate to SIGKILL after 250 ms grace period.
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
        }
        setTimeout(() => {
          try {
            // Negative pid => send to the whole process group.
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }
        }, 250);
      } else {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }

    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;

    const timer = setTimeout(killTree, opts.timeoutMs);
    const onAbort = (): void => killTree();
    if (opts.signal) {
      if (opts.signal.aborted) killTree();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const deadline = setTimeout(
      () => settle(exitCode, "hard deadline"),
      opts.timeoutMs + 250 + HARD_DEADLINE_SLACK_MS,
    );

    /** Resolve exactly once and clear every timer. */
    function settle(code: number | null, note?: string, spawnErr?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      if (drainTimer) clearTimeout(drainTimer);
      let err = stderr;
      if (spawnErr) err += `\n[spawn error: ${spawnErr.message}]`;
      else if (note && code === null) err += `\n[_run-with-timeout: settled by ${note}]`;
      resolveP({
        stdout,
        stderr: err,
        exitCode: spawnErr ? -1 : (code ?? -1),
        timedOut,
      });
    }

    child.on("exit", (code) => {
      exitCode = code;
      // `close` normally follows within milliseconds. If it does not (a pipe
      // held open, or a lost event), settle with what we have.
      drainTimer = setTimeout(() => settle(code, "exit drain"), EXIT_DRAIN_MS);
    });

    child.on("close", (code) => settle(code ?? exitCode));

    child.on("error", (err) => settle(null, undefined, err));
  });
}
