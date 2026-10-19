/**
 * Spend a file's first subprocess spawn on a disposable child.
 *
 * On macOS CI the first spawn in a test file has repeatedly never reported
 * `exit` or `close`, even for `echo` and for a hook that exits at once, while
 * every later spawn in the same file finished in normal time (ashlr-plugin
 * main runs 39033495253 to 39269756774: five such failures in 29 macOS jobs,
 * all in the first test of pulse-emit.test.ts or run-with-timeout.test.ts).
 * The children were not slow: passing runs take 8 to 45 ms for that `echo`
 * and 220 to 290 ms for that hook, and the failures sat until a 7, 15 or 30 s
 * deadline. A file that calls this in `beforeAll` takes that first spawn on a
 * child whose result no test asserts.
 *
 * Settles exactly once, on the first of `exit`, `close`, a spawn error or the
 * deadline (after which the child is killed). It never rejects, so a lost exit
 * here costs at most `deadlineMs` and fails nothing.
 */

import { spawn } from "node:child_process";

export interface WarmUpResult {
	/** How the warm-up child settled. */
	outcome: "exit" | "close" | "error" | "deadline";
	elapsedMs: number;
}

export function warmUpSpawn(deadlineMs = 3_000): Promise<WarmUpResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(process.execPath, ["--version"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		const settle = (outcome: WarmUpResult["outcome"]) => {
			if (settled) return;
			settled = true;
			clearTimeout(guard);
			resolve({ outcome, elapsedMs: Date.now() - started });
		};
		const guard = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			settle("deadline");
		}, deadlineMs);
		child.on("error", () => settle("error"));
		child.on("exit", () => settle("exit"));
		child.on("close", () => settle("close"));
	});
}
