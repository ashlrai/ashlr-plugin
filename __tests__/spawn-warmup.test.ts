import { describe, expect, test } from "bun:test";
import { warmUpSpawn } from "./_spawn-warmup";

describe("warmUpSpawn", () => {
	test("settles on the child's exit well inside the deadline", async () => {
		const r = await warmUpSpawn(10_000);
		expect(["exit", "close"]).toContain(r.outcome);
		expect(r.elapsedMs).toBeLessThan(10_000);
	});

	test("settles at the deadline instead of waiting on the child, and never rejects", async () => {
		const r = await warmUpSpawn(0);
		expect(["deadline", "exit", "close"]).toContain(r.outcome);
		expect(r.elapsedMs).toBeLessThan(2_000);
	});
});
