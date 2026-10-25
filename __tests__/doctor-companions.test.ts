/**
 * `ashlr doctor` companions section: --ashlr-handshake probes through an
 * injected runner. Missing or outdated companions are info lines with a fix
 * hint and never count as warnings or failures.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildReport, formatReport } from "../scripts/doctor.ts";
import {
	type CompanionRunner,
	companionEnv,
	defaultCompanionRunner,
	detectCompanions,
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
	if (cmd === "locus") return { kind: "ran", code: 0, stdout: hs("0.5.1", ["recall"]) };
	if (cmd === "lexicon") return { kind: "ran", code: 0, stdout: hs("0.6.0", [], "degraded") };
	if (cmd === "phantom") return { kind: "ran", code: 2, stdout: "error: unexpected argument" };
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
		expect(by.locus).toMatchObject({ state: "ready", version: "0.5.1", capabilities: ["recall"], fix: null });
		expect(by.lexicon.state).toBe("degraded");
		expect(by["phantom-secrets"].state).toBe("outdated");
		expect(by["phantom-secrets"].fix).toContain("upgrade phantom-secrets");
		expect(by.phantom.state).toBe("outdated");
		expect(by["ashlr-md"]).toMatchObject({ state: "missing", command: "mdopener-mcp" });
		expect(by["ashlr-md"].fix).toContain("optional: install ashlr-md");
	});

	test("a throwing runner reads as missing", async () => {
		const out = await detectCompanions(async () => {
			throw new Error("boom");
		});
		expect(out.every((r) => r.state === "missing")).toBe(true);
	});

	test("env passes no secrets", () => {
		expect(companionEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", GH_TOKEN: "t" })).toEqual({
			PATH: "/bin",
			NO_COLOR: "1",
		});
	});

	test("default runner: a missing binary is missing", async () => {
		expect(await defaultCompanionRunner("ashlr-not-installed-xyz", 500)).toEqual({ kind: "missing" });
	});
});

describe("doctor companions section", () => {
	async function report() {
		const root = await mkdtemp(join(tmpdir(), "ashlr-cmp-root-"));
		await mkdir(join(root, ".claude-plugin"), { recursive: true });
		await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "ashlr", version: "0.4.0" }));
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
		expect(locus).toMatchObject({ status: "ok", detail: "0.5.1 ready [recall]" });
		const md = section?.lines.find((l) => l.label === "ashlr-md");
		expect(md?.status).toBe("info");
		expect(r.companions).toHaveLength(6);

		const without = { ...r, sections: r.sections.filter((s) => s.title !== "companions") };
		const count = (rep: typeof r, st: string) =>
			rep.sections.flatMap((s) => s.lines).filter((l) => l.status === st).length;
		expect(r.warnings).toBe(count(without, "warn"));
		expect(r.failures).toBe(count(without, "fail"));

		const text = formatReport(r);
		expect(text).toContain("companions");
		expect(text).toContain("fix: optional: install ashlr-md");
		expect(JSON.parse(JSON.stringify(r)).companions[2].version).toBe("0.5.1");
	});
});
