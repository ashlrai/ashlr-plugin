/**
 * Opt-in Phantom agent preflight (phantom-secrets docs/agent-preflight-contract.md):
 * off by default, exit codes 0-3, warn-only when phantom is missing or old,
 * and only the verdict and check ids ever reach doctor output.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildReport } from "../scripts/doctor.ts";
import {
	type PreflightRunner,
	preflightMode,
	runPhantomPreflight,
} from "../servers/_phantom-preflight.ts";

function doc(verdict: string, blockedBy: string[] = []): string {
	return JSON.stringify({
		schema_version: 1,
		kind: "phantom.agent.preflight",
		verdict,
		readiness: verdict === "unknown" ? null : "protected",
		risk_level: verdict === "unknown" ? null : "medium",
		vault_probed: false,
		checks: blockedBy.map((id) => ({
			id,
			severity: "critical",
			requires_approval: false,
		})),
		wrap: { exec_ready: blockedBy.length === 0, blocked_by: blockedBy },
	});
}
const runner =
	(status: number | null, stdout: string, missing = false): PreflightRunner =>
	() => ({ status, stdout, missing });

describe("preflightMode", () => {
	test("off by default and for unknown values", () => {
		expect(preflightMode({})).toBe("off");
		expect(preflightMode({ ASHLR_PHANTOM_PREFLIGHT: "0" })).toBe("off");
		expect(preflightMode({ ASHLR_PHANTOM_PREFLIGHT: "maybe" })).toBe("off");
	});
	test("on and strict", () => {
		expect(preflightMode({ ASHLR_PHANTOM_PREFLIGHT: "1" })).toBe("on");
		expect(preflightMode({ ASHLR_PHANTOM_PREFLIGHT: "on" })).toBe("on");
		expect(preflightMode({ ASHLR_PHANTOM_PREFLIGHT: "STRICT" })).toBe("strict");
	});
});

describe("runPhantomPreflight", () => {
	test("off never runs phantom", () => {
		let ran = false;
		expect(
			runPhantomPreflight("off", () => {
				ran = true;
				return { status: 0, stdout: doc("ready"), missing: false };
			}),
		).toBeNull();
		expect(ran).toBe(false);
	});

	test.each([
		["on", 0, "ready", "ok"],
		["on", 2, "degraded", "warn"],
		["on", 1, "blocked", "fail"],
		["on", 3, "unknown", "warn"],
		["strict", 0, "ready", "ok"],
		["strict", 2, "degraded", "fail"],
		["strict", 1, "blocked", "fail"],
		["strict", 3, "unknown", "fail"],
	] as const)("%s mode, exit %d (%s) is %s", (mode, exit, verdict, status) => {
		const r = runPhantomPreflight(
			mode,
			runner(
				exit,
				doc(verdict, verdict === "blocked" ? ["unprotected-env-file"] : []),
			),
		)!;
		expect(r.verdict).toBe(verdict);
		expect(r.status).toBe(status);
	});

	test("blocked names check ids only; anything that is not an id is dropped", () => {
		const r = runPhantomPreflight(
			"on",
			runner(
				1,
				doc("blocked", ["unprotected-env-file", "OPENAI_API_KEY=sk-live-x"]),
			),
		)!;
		expect(r.blockedBy).toEqual(["unprotected-env-file"]);
		expect(r.detail).toBe("blocked (unprotected-env-file)");
	});

	test("missing phantom is a warning even in strict", () => {
		const r = runPhantomPreflight("strict", runner(null, "", true))!;
		expect(r.status).toBe("warn");
		expect(r.detail).toContain("not installed");
	});

	test.each([
		[
			"an older phantom",
			2,
			"error: unrecognized subcommand 'agent' sk-live-secret",
		],
		[
			"another kind",
			0,
			JSON.stringify({ schema_version: 1, kind: "x", verdict: "ready" }),
		],
		[
			"a newer schema",
			1,
			JSON.stringify({
				schema_version: 2,
				kind: "phantom.agent.preflight",
				verdict: "blocked",
			}),
		],
		["an exit outside 0-3", 101, doc("ready")],
	])("%s degrades to a warning without echoing output", (_n, exit, stdout) => {
		const r = runPhantomPreflight("strict", runner(exit, stdout))!;
		expect(r.status).toBe("warn");
		expect(r.verdict).toBeNull();
		expect(r.detail).not.toContain("sk-live");
	});
});

describe("doctor phantom preflight line", () => {
	async function report(env: Record<string, string>, run: PreflightRunner) {
		const root = await mkdtemp(join(tmpdir(), "ashlr-pf-root-"));
		await mkdir(join(root, ".claude-plugin"), { recursive: true });
		await writeFile(
			join(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "ashlr", version: "0.4.0" }),
		);
		const home = await mkdtemp(join(tmpdir(), "ashlr-pf-home-"));
		return buildReport({
			root,
			home,
			cwd: home,
			env,
			fetchLatest: async () => "0.4.0",
			probe: async () => [],
			bunVersion: async () => "1.3.10",
			phantomVersion: async () => "phantom 0.7.9",
			phantomPreflight: run,
		});
	}
	const line = (r: Awaited<ReturnType<typeof report>>) =>
		r.sections
			.flatMap((s) => s.lines)
			.find((l) => l.label === "phantom preflight");

	test("absent by default, and the runner is not called", async () => {
		let ran = false;
		const r = await report({}, () => {
			ran = true;
			return { status: 1, stdout: doc("blocked", ["x"]), missing: false };
		});
		expect(line(r)).toBeUndefined();
		expect(ran).toBe(false);
	});

	test("on: blocked is a fail line with the check ids", async () => {
		const l = line(
			await report(
				{ ASHLR_PHANTOM_PREFLIGHT: "1" },
				runner(1, doc("blocked", ["unprotected-env-file"])),
			),
		);
		expect(l?.status).toBe("fail");
		expect(l?.detail).toBe("blocked (unprotected-env-file)");
	});

	test("on: ready is ok", async () => {
		const l = line(
			await report({ ASHLR_PHANTOM_PREFLIGHT: "1" }, runner(0, doc("ready"))),
		);
		expect(l?.status).toBe("ok");
		expect(l?.detail).toBe("ready");
	});
});
