/**
 * Spend a file's first subprocess spawn on a disposable child.
 *
 * On macOS CI a spawn has repeatedly never reported `exit` or `close`, even
 * for `echo` and for a hook that exits at once, while every later spawn in
 * the same file finished in normal time (ashlr-plugin main runs 39033495253
 * to 39269756774: five such failures in 29 macOS jobs, all in the first test
 * of pulse-emit.test.ts or run-with-timeout.test.ts). The children were not
 * slow: passing runs take 8 to 45 ms for that `echo` and 220 to 290 ms for
 * that hook, and the failures sat until a 7, 15 or 30 s deadline. A file that
 * calls this in `beforeAll` takes that first spawn on a child whose result no
 * test asserts.
 *
 * Two details matter:
 *   - The child uses the same spawn shape as runWithTimeout (own process
 *     group via `detached`, piped and drained stdio) so the machinery it
 *     warms is the machinery the real calls rely on.
 *   - One warm spawn is not always enough: the same lost-exit symptom has hit
 *     a second spawn too (main runs 40171693717 and 40242679978). So this
 *     keeps spawning cheap children until one actually reports `exit`,
 *     `close` or `error`, or the whole budget is spent. A warm-up that never
 *     sees an event still resolves "deadline" and fails nothing; it just
 *     means the runner's process notifications are genuinely broken.
 *
 * Never rejects, so a lost exit here costs at most `deadlineMs` total.
 */

import { spawn } from "node:child_process";

export interface WarmUpResult {
	/** How the warm-up settled: the first observed event, or "deadline". */
	outcome: "exit" | "close" | "error" | "deadline";
	elapsedMs: number;
	/** How many disposable children were spawned before settling. */
	attempts: number;
}

/** Cap per child; a healthy spawn reports its event in tens of ms. */
const PER_ATTEMPT_MS = 750;

export function warmUpSpawn(deadlineMs = 3_000): Promise<WarmUpResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let attempts = 0;

		const attempt = (): void => {
			const remaining = deadlineMs - (Date.now() - started);
			if (remaining <= 0) {
				resolve({ outcome: "deadline", elapsedMs: Date.now() - started, attempts });
				return;
			}
			attempts += 1;
			let settled = false;
			// Same shape as runWithTimeout: own process group, piped stdio.
			const child = spawn(process.execPath, ["--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			// Drain the pipes so output never back-pressures the child.
			child.stdout?.resume();
			child.stderr?.resume();
			const settle = (outcome: WarmUpResult["outcome"]): void => {
				if (settled) return;
				settled = true;
				clearTimeout(guard);
				if (outcome === "deadline" && Date.now() - started < deadlineMs) {
					// Lost the event again; spend the next attempt inside budget.
					attempt();
					return;
				}
				resolve({ outcome, elapsedMs: Date.now() - started, attempts });
			};
			const guard = setTimeout(() => {
				// Kill the group like runWithTimeout does; the shell-shaped
				// children above leave no grandchildren, but be consistent.
				try {
					if (child.pid != null && process.platform !== "win32") {
						process.kill(-child.pid, "SIGKILL");
					} else {
						child.kill("SIGKILL");
					}
				} catch {
					try { child.kill("SIGKILL"); } catch { /* already gone */ }
				}
				settle("deadline");
			}, Math.min(PER_ATTEMPT_MS, remaining));
			child.on("error", () => settle("error"));
			child.on("exit", () => settle("exit"));
			child.on("close", () => settle("close"));
		};

		attempt();
	});
}
