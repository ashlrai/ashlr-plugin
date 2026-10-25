/**
 * `ashlr doctor` companions section: --ashlr-handshake probes through an
 * injected runner. Missing or outdated companions are info lines with a fix
 * hint and never count as warnings or failures.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildReport, formatReport } from "../scripts/doctor.ts";
import {
	type CompanionRunner,
	companionEnv,
	defaultCompanionRunner,
	detectCompanions,
	LEXICON_DOCTOR_FIX_STEP,
	LOCUS_DOCTOR_FIX_STEP,
	MDOPENER_DOCTOR_FIX_STEP,
} from "../servers/_companions.ts";

const hs = (version: string, caps: string[], health = "ok") =>
	JSON.stringify({
		kind: "ashlr.handshake",
		schema_version: 1,
		version,
		capabilities: caps,
		health: { status: health, checks: [] },
	});

const runner: CompanionRunner = async (cmd) => {
	if (cmd === "locus")
		return { kind: "ran", code: 0, stdout: hs("0.5.1", ["recall"]) };
	if (cmd === "lexicon")
		return { kind: "ran", code: 0, stdout: hs("0.6.0", [], "degraded") };
	if (cmd === "phantom")
		return { kind: "ran", code: 2, stdout: "error: unexpected argument" };
	if (cmd === "phm") return { kind: "timeout" };
	return { kind: "missing" };
};

describe("detectCompanions", () => {
	test("ready, degraded, outdated, timeout and missing", async () => {
		const seen: number[] = [];
		const out = await detectCompanions(async (c, t) => {
			seen.push(t);
			return runner(c, t);
		});
		expect(seen.every((t) => t === 2000)).toBe(true);
		const by = Object.fromEntries(out.map((r) => [r.name, r]));
		expect(by.locus).toMatchObject({
			state: "ready",
			version: "0.5.1",
			capabilities: ["recall"],
			fix: null,
		});
		expect(by.lexicon).toMatchObject({
			state: "degraded",
			health: "degraded",
			next_steps: [],
		});
		expect(by["phantom-secrets"].state).toBe("outdated");
		expect(by["phantom-secrets"].fix).toContain("upgrade phantom-secrets");
		expect(by.phantom.state).toBe("unknown");
		expect(by["ashlr-md"]).toMatchObject({
			state: "missing",
			command: "mdopener-mcp",
		});
		expect(by["ashlr-md"].fix).toContain("optional: install ashlr-md");
	});

	test("a throwing runner reads as missing", async () => {
		const out = await detectCompanions(async () => {
			throw new Error("boom");
		});
		expect(out.every((r) => r.state === "missing")).toBe(true);
	});

	test("env passes no secrets", () => {
		expect(
			companionEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", GH_TOKEN: "t" }),
		).toEqual({
			PATH: "/bin",
			NO_COLOR: "1",
		});
	});

	test("default runner: a missing binary is missing", async () => {
		expect(
			await defaultCompanionRunner("ashlr-not-installed-xyz", 500),
		).toEqual({ kind: "missing" });
	});
});

describe("capability-gated next steps", () => {
	const only =
		(stdout: string): CompanionRunner =>
		async (cmd) =>
			cmd === "locus" ? { kind: "ran", code: 0, stdout } : { kind: "missing" };
	const locus = async (stdout: string) =>
		(await detectCompanions(only(stdout))).find((r) => r.name === "locus")!;

	test("degraded locus with doctor-fix gets locus doctor --fix", async () => {
		const r = await locus(hs("0.5.2", ["doctor-fix"], "degraded"));
		expect(r.next_steps).toEqual([LOCUS_DOCTOR_FIX_STEP]);
		expect(r.fix).toContain("locus doctor --fix");
	});

	test("healthy locus with doctor-fix: nothing extra", async () => {
		const r = await locus(hs("0.5.2", ["doctor-fix"], "ok"));
		expect(r).toMatchObject({
			state: "ready",
			health: "ok",
			next_steps: [],
			fix: null,
		});
	});

	test("degraded locus without doctor-fix: no guess from version", async () => {
		for (const v of ["0.5.1", "0.6.0", "9.9.9"]) {
			const r = await locus(hs(v, ["doctor-json"], "degraded"));
			expect(r.next_steps).toEqual([]);
			expect(r.fix).not.toContain("doctor --fix");
		}
	});

	test("unparseable JSON and wrong shape read as unknown, not a crash", async () => {
		expect((await locus("{not json")).state).toBe("unknown");
		expect((await locus(JSON.stringify({ kind: "other" }))).state).toBe(
			"unknown",
		);
		expect((await locus("null")).state).toBe("unknown");
		expect((await locus("usage: locus [OPTIONS]")).state).toBe("outdated");
	});
});

describe("lexicon and ashlr-md doctor --fix hints", () => {
	const probe = async (name: string, command: string, stdout: string) =>
		(
			await detectCompanions(
				async (cmd) =>
					cmd === command
						? { kind: "ran", code: 0, stdout }
						: { kind: "missing" },
				[{ name, command, repo: `ashlrai/${name}` }],
			)
		)[0];
	const cases = [
		["lexicon", "lexicon", LEXICON_DOCTOR_FIX_STEP],
		["ashlr-md", "mdopener-mcp", MDOPENER_DOCTOR_FIX_STEP],
	] as const;

	for (const [name, command, step] of cases) {
		test(`degraded ${name} with doctor-fix gets ${command} doctor --fix`, async () => {
			const r = await probe(
				name,
				command,
				hs("0.7.0", ["doctor-fix"], "degraded"),
			);
			expect(r.next_steps).toEqual([step]);
			expect(r.fix).toContain(`${command} doctor --fix`);
			expect(r.fix).not.toContain("locus");
		});

		test(`healthy ${name} with doctor-fix: nothing extra`, async () => {
			const r = await probe(name, command, hs("0.7.0", ["doctor-fix"], "ok"));
			expect(r).toMatchObject({ state: "ready", next_steps: [], fix: null });
		});

		test(`degraded ${name} without doctor-fix: no guess from version`, async () => {
			for (const v of ["0.1.0", "1.0.0", "9.9.9"]) {
				const r = await probe(
					name,
					command,
					hs(v, ["doctor-json"], "degraded"),
				);
				expect(r.next_steps).toEqual([]);
				expect(r.fix).not.toContain("doctor --fix");
			}
		});
	}

	test("companions without a doctor --fix entry never get one, even with the capability", async () => {
		for (const [name, command] of [
			["phantom", "phm"],
			["ashlr-stack", "stack"],
			["toString", "x"],
		]) {
			const r = await probe(
				name,
				command,
				hs("1.0.0", ["doctor-fix"], "degraded"),
			);
			expect(r.state).toBe("degraded");
			expect(r.next_steps).toEqual([]);
		}
	});
});

describe("stand-in companion binaries on PATH", () => {
	test("real spawn: degraded locus stand-in gets the hint; env carries no secrets", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(join(tmpdir(), "ashlr-cmp-bin-"));
		const out = join(dir, "env.txt");
		const script = `#!/bin/sh\nenv > "${out}"\nprintf '%s' '${hs("0.5.2", ["doctor-fix"], "degraded")}'\n`;
		await writeFile(join(dir, "locus"), script, { mode: 0o755 });
		const prevPath = process.env.PATH;
		const prevSecret = process.env.ASHLR_TEST_SECRET_TOKEN;
		process.env.PATH = `${dir}:${prevPath}`;
		process.env.ASHLR_TEST_SECRET_TOKEN = "sk-should-not-leak";
		try {
			const [r] = await detectCompanions(undefined, [
				{ name: "locus", command: "locus", repo: "ashlrai/locus" },
			]);
			expect(r).toMatchObject({
				state: "degraded",
				version: "0.5.2",
				next_steps: [LOCUS_DOCTOR_FIX_STEP],
			});
			const env = await readFile(out, "utf8");
			expect(env).not.toContain("sk-should-not-leak");
		} finally {
			process.env.PATH = prevPath;
			if (prevSecret === undefined) delete process.env.ASHLR_TEST_SECRET_TOKEN;
			else process.env.ASHLR_TEST_SECRET_TOKEN = prevSecret;
		}
	});

	test("real spawn: degraded mdopener-mcp stand-in gets its hint; env carries no secrets", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(join(tmpdir(), "ashlr-cmp-bin-"));
		const out = join(dir, "env.txt");
		const script = `#!/bin/sh\nenv > "${out}"\nprintf '%s' '${hs("0.4.0", ["doctor-fix"], "degraded")}'\n`;
		await writeFile(join(dir, "mdopener-mcp"), script, { mode: 0o755 });
		const prevPath = process.env.PATH;
		const prevSecret = process.env.ASHLR_TEST_SECRET_TOKEN;
		process.env.PATH = `${dir}:${prevPath}`;
		process.env.ASHLR_TEST_SECRET_TOKEN = "sk-should-not-leak";
		try {
			const [r] = await detectCompanions(undefined, [
				{ name: "ashlr-md", command: "mdopener-mcp", repo: "ashlrai/ashlr-md" },
			]);
			expect(r).toMatchObject({
				state: "degraded",
				next_steps: [MDOPENER_DOCTOR_FIX_STEP],
			});
			const env = await readFile(out, "utf8");
			expect(env).not.toContain("sk-should-not-leak");
		} finally {
			process.env.PATH = prevPath;
			if (prevSecret === undefined) delete process.env.ASHLR_TEST_SECRET_TOKEN;
			else process.env.ASHLR_TEST_SECRET_TOKEN = prevSecret;
		}
	});

	test("real spawn: a hanging stand-in is cut off near the timeout", async () => {
		if (process.platform === "win32") return;
		const dir = await mkdtemp(join(tmpdir(), "ashlr-cmp-bin-"));
		await writeFile(join(dir, "slowtool"), "#!/bin/sh\nexec sleep 30\n", {
			mode: 0o755,
		});
		const prevPath = process.env.PATH;
		process.env.PATH = `${dir}:${prevPath}`;
		try {
			const t0 = Date.now();
			const [r] = await detectCompanions(
				undefined,
				[{ name: "slow", command: "slowtool", repo: "x/y" }],
				300,
			);
			expect(r.state).toBe("unknown");
			expect(Date.now() - t0).toBeLessThan(5000);
		} finally {
			process.env.PATH = prevPath;
		}
	});
});

describe("doctor companions section", () => {
	async function report() {
		const root = await mkdtemp(join(tmpdir(), "ashlr-cmp-root-"));
		await mkdir(join(root, ".claude-plugin"), { recursive: true });
		await writeFile(
			join(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "ashlr", version: "0.4.0" }),
		);
		const home = await mkdtemp(join(tmpdir(), "ashlr-cmp-home-"));
		return buildReport({
			root,
			home,
			cwd: home,
			env: {},
			fetchLatest: async () => "0.4.0",
			probe: async () => [],
			bunVersion: async () => "1.3.10",
			phantomVersion: async () => "phantom 0.7.9",
			companionRunner: runner,
		});
	}

	test("lines, fix hints, JSON field, and no effect on counts", async () => {
		const r = await report();
		const section = r.sections.find((s) => s.title === "companions");
		expect(section?.lines.map((l) => l.label)).toEqual([
			"phantom",
			"phantom-secrets",
			"locus",
			"lexicon",
			"ashlr-md",
			"ashlr-stack",
		]);
		const locus = section?.lines.find((l) => l.label === "locus");
		expect(locus).toMatchObject({
			status: "ok",
			detail: "0.5.1 ready [recall]",
		});
		const lex = section?.lines.find((l) => l.label === "lexicon");
		expect(lex).toMatchObject({
			status: "info",
			detail: "0.6.0 health: degraded",
		});
		const md = section?.lines.find((l) => l.label === "ashlr-md");
		expect(md?.status).toBe("info");
		expect(r.companions).toHaveLength(6);

		const without = {
			...r,
			sections: r.sections.filter((s) => s.title !== "companions"),
		};
		const count = (rep: typeof r, st: string) =>
			rep.sections.flatMap((s) => s.lines).filter((l) => l.status === st)
				.length;
		expect(r.warnings).toBe(count(without, "warn"));
		expect(r.failures).toBe(count(without, "fail"));

		const text = formatReport(r);
		expect(text).toContain("companions");
		expect(text).toContain("fix: optional: install ashlr-md");
		expect(JSON.parse(JSON.stringify(r)).companions[2].version).toBe("0.5.1");
	});
});
