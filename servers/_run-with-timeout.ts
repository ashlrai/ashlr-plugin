/**
 * _run-with-timeout.ts - async subprocess wrapper with process-group cleanup.
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
 *   - Never throws on subprocess error - returns `exitCode: -1` with the error
 *     surfaced in `stderr`.
 *   - Always settles. `close` is the normal path, but it waits for every stdio
 *     pipe to end and has been seen not to fire at all (ashlr-plugin main run
 *     39195707592, macOS: an `echo` call outlived its own 5 s timeout and hit
 *     the 15 s test timeout). So `exit` starts a short drain window after
 *     which we resolve with what was collected, and a hard deadline slightly
 *     past the kill grace resolves a run that never reports `exit` or `close`.
 *
 * Lost-exit defence (macOS Bun flake, RQ-N26B-091):
 *   Under bun on macOS the runtime intermittently never reaps a spawned child:
 *   the process exits, becomes a zombie, and neither `exit` nor `close` is ever
 *   delivered, while `child.exitCode` stays null forever (oven-sh/bun#34069).
 *   stdio data still flows in that state, so on POSIX the real command runs
 *   under a thin `/bin/sh` wrapper that prints its exit status to stderr as a
 *   trailing marker line:
 *
 *     sh -c '"$@"; rc=$?; printf "<marker>%s__\n" "$rc" >&2' run-with-timeout \
 *       <command> <args...>
 *
 *   The marker rides the stderr pipe, which keeps working when the process
 *   notification does not, so the run settles with the real exit code even
 *   when `exit`/`close` are never emitted. The marker is stripped from the
 *   returned stderr. A marker per call makes collisions with real stderr
 *   output a non-issue. Windows keeps the direct spawn.
 *
 *   Because `sh` itself always spawns, a missing/ non-executable command can
 *   no longer surface through the `error` event. To keep the `exitCode: -1`
 *   contract we resolve `command` the way execvp would (PATH search of the
 *   child env, or the given path relative to the child cwd) before spawning,
 *   and return -1 immediately when the lookup fails.
 *
 *   `ASHLR_RWT_SIMULATE_LOST_EXIT=1` is a test hook: when set, `exit`/`close`
 *   listeners are not registered, reproducing the Bun failure shape so tests
 *   can prove the trailer path returns the real exit code. Never set it in
 *   production.
 *
 *   - Stdout and stderr are each capped at 10 MB to prevent OOM on runaway
 *     output; excess bytes are silently dropped (the cap notice appears in
 *     stderr so callers can detect truncation).
 */

import { spawn } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { join, resolve } from "path";

/** After `exit`, how long to wait for `close` (pipes drained) before settling. */
const EXIT_DRAIN_MS = 1_000;
/**
 * After the trailer reports the command finished, how long to keep collecting
 * stream data. Shorter than EXIT_DRAIN_MS: the command is provably done, only
 * in-flight pipe bytes remain.
 */
const TRAILER_DRAIN_MS = 100;
/** Past the timeout and the 250 ms SIGKILL grace, how long before we give up. */
const HARD_DEADLINE_SLACK_MS = 2_000;

/** Maximum bytes buffered per stream before we stop accumulating. */
const STREAM_CAP = 10 * 1024 * 1024; // 10 MB

/** execvp's default PATH when the child env carries no PATH at all. */
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

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
 * Resolve `command` the way execvp would and return null when it can run, or
 * the errno string ("ENOENT" | "EACCES") when it cannot. Used on POSIX where
 * the command runs under an `sh` wrapper and a missing binary would otherwise
 * surface as exit 127 instead of the -1 spawn-error contract. PATH entries
 * and relative paths resolve against the child's cwd.
 */
function execLookupError(
  command: string,
  env: Record<string, string>,
  childCwd: string | undefined,
): "ENOENT" | "EACCES" | null {
  const base = childCwd ?? process.cwd();
  const check = (p: string): "ENOENT" | "EACCES" | null => {
    try {
      if (!statSync(p).isFile()) return "EACCES";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EACCES" ? "EACCES" : "ENOENT";
    }
    try {
      accessSync(p, constants.X_OK);
      return null;
    } catch {
      return "EACCES";
    }
  };
  if (command.includes("/")) return check(resolve(base, command));
  const pathEnv: string | undefined = env.PATH;
  let sawEacces = false;
  for (const dir of (pathEnv ?? DEFAULT_PATH).split(":")) {
    const r = check(join(dir === "" ? base : dir, command));
    if (r === null) return null;
    if (r === "EACCES") sawEacces = true;
  }
  return sawEacces ? "EACCES" : "ENOENT";
}

/**
 * Spawn `command args` and collect stdout/stderr, killing the process (group)
 * after `timeoutMs` milliseconds. Returns a resolved Promise - never rejects.
 */
export function runWithTimeout(opts: RunWithTimeoutOptions): Promise<RunWithTimeoutResult> {
  return new Promise((resolveP) => {
    const isWin = process.platform === "win32";
    const env = opts.env ?? (process.env as Record<string, string>);

    // On POSIX the command runs under an `sh` wrapper (see file header), so a
    // missing binary would surface as exit 127. Keep the -1 contract by
    // resolving the command first, the way execvp would.
    if (!isWin) {
      const miss = execLookupError(opts.command, env, opts.cwd);
      if (miss) {
        resolveP({
          stdout: "",
          stderr: `[spawn error: spawn ${opts.command} ${miss}]`,
          exitCode: -1,
          timedOut: false,
        });
        return;
      }
    }

    // The trailer marker the `sh` wrapper prints on stderr once the command
    // finishes. Per-call random tag so real stderr cannot collide with it.
    const markerTag = `__RWT_EXIT_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const markerRe = new RegExp(`${markerTag}_(\\d+)__`);
    const stripRe = new RegExp(`\\n?${markerTag}_\\d+__\\n?`);

    const child = isWin
      ? spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env,
          stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        })
      : spawn(
          "/bin/sh",
          [
            "-c",
            `"$@"; rc=$?; printf '\\n${markerTag}_%s__\\n' "$rc" >&2`,
            "run-with-timeout",
            opts.command,
            ...opts.args,
          ],
          {
            cwd: opts.cwd,
            env,
            stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
            // POSIX: own process group so timeout can kill the whole tree.
            detached: true,
          },
        );

    // Test hook: reproduce Bun's lost-exit shape by never subscribing to the
    // process events. Trailer + drain must still settle the run.
    const noProcEvents = !isWin && !!process.env.ASHLR_RWT_SIMULATE_LOST_EXIT;

    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    // On POSIX the spawned process is the `sh` wrapper, which always exits 0
    // once the trailer prints, so the real status comes from the trailer.
    // `eventCode` is the wrapper's own code (Windows: the command's code).
    let trailerCode: number | null = null;
    let eventCode: number | null = null;
    const reportedCode = (): number | null => trailerCode ?? eventCode;
    let stdoutEnded = false;
    let stderrEnded = false;
    // Sliding tail of stderr bytes used to catch a marker split across chunks.
    let scanTail = "";

    const noteCompletion = (drainMs: number): void => {
      if (settled || drainTimer) return;
      // When every stream already ended there is nothing left to wait for.
      if (stdoutEnded && stderrEnded) settle(reportedCode());
      else drainTimer = setTimeout(() => settle(reportedCode(), "exit drain"), drainMs);
    };

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
    child.stdout?.on("end", () => { stdoutEnded = true; });

    child.stderr?.on("data", (b: Buffer) => {
      const chunk = b.toString("utf-8");
      if (!isWin) {
        // Scan a sliding tail so a marker split across chunk boundaries is
        // still caught. This runs even when the cap drops the chunk: the
        // trailer still reports the real exit code.
        const scan = scanTail + chunk;
        const m = markerRe.exec(scan);
        if (m) {
          trailerCode = parseInt(m[1], 10);
          noteCompletion(TRAILER_DRAIN_MS);
        }
        scanTail = scan.slice(-64);
      }
      if (stderr.length >= STREAM_CAP) {
        if (!stderrCapped) {
          stderrCapped = true;
          stderr += `\n[_run-with-timeout: stderr capped at ${STREAM_CAP} bytes]\n`;
        }
        return;
      }
      const remaining = STREAM_CAP - stderr.length;
      if (b.length <= remaining) {
        stderr += chunk;
      } else {
        // Truncate the chunk so total stays at exactly STREAM_CAP.
        stderr += b.subarray(0, remaining).toString("utf-8");
        if (!stderrCapped) {
          stderrCapped = true;
          stderr += `\n[_run-with-timeout: stderr capped at ${STREAM_CAP} bytes]\n`;
        }
      }
    });
    child.stderr?.on("end", () => { stderrEnded = true; });

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
            // Ignore - process may already be gone.
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

    const timer = setTimeout(killTree, opts.timeoutMs);
    const onAbort = (): void => killTree();
    if (opts.signal) {
      if (opts.signal.aborted) killTree();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const deadline = setTimeout(
      () => settle(reportedCode(), "hard deadline"),
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
      if (!isWin) err = err.replace(stripRe, "");
      if (spawnErr) err += `\n[spawn error: ${spawnErr.message}]`;
      else if (note && code === null) err += `\n[_run-with-timeout: settled by ${note}]`;
      resolveP({
        stdout,
        stderr: err,
        exitCode: spawnErr ? -1 : (code ?? -1),
        timedOut,
      });
    }

    if (!noProcEvents) {
      child.on("exit", (code) => {
        eventCode = code;
        noteCompletion(EXIT_DRAIN_MS);
      });
      child.on("close", (code) => {
        if (code !== null) eventCode = code;
        settle(reportedCode());
      });
    }
    child.on("error", (err) => settle(null, undefined, err));
  });
}
