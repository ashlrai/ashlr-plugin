import { describe, expect, test } from "bun:test";
import { warmUpSpawn } from "./_spawn-warmup";

describe("warmUpSpawn", () => {
	// The first spawn on a cold macOS runner can itself lose its exit event
	// (that is why this helper exists), so the cold call may settle either
	// way. The event path is asserted on a warm call. Main runs 40171693717
	// (ac65b4b) and 40242679978 (d4646f2) failed only here, on macOS; the
	// helper now retries inside its budget until an event is observed.
	test("settles on the child's exit once spawning is warm", async () => {
		const cold = await warmUpSpawn(10_000);
		expect(["exit", "close", "deadline"]).toContain(cold.outcome);
		expect(cold.elapsedMs).toBeLessThan(12_000);
		expect(cold.attempts).toBeGreaterThanOrEqual(1);
		const warm = await warmUpSpawn(10_000);
		expect(["exit", "close"]).toContain(warm.outcome);
		// A successful attempt returns in tens of ms; only a runner that
		// drops every event would burn the whole 10 s budget (and fail the
		// outcome check above), so allow the full budget plus slack.
		expect(warm.elapsedMs).toBeLessThan(12_000);
	}, 30_000);

	test("settles at the deadline instead of waiting on the child, and never rejects", async () => {
		const r = await warmUpSpawn(0);
		expect(["deadline", "exit", "close"]).toContain(r.outcome);
		expect(r.elapsedMs).toBeLessThan(2_000);
	});
});
