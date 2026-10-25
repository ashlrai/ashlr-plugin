import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
// @ts-expect-error: plain .mjs module without types
import { buildHandshake, wantsHandshake } from "../scripts/handshake.mjs";

const ROOT = join(import.meta.dir, "..");
const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("ashlr handshake v1", () => {
	test("identifies the contract and the plugin", () => {
		const h = buildHandshake("9.9.9", { bun: true, phantom: true });
		expect(h.kind).toBe("ashlr.handshake");
		expect(h.schema_version).toBe(1);
		expect(h).toMatchObject({
			name: "ashlr-plugin",
			command: "ashlr-plugin",
			version: "9.9.9",
		});
		expect(h.protocols["phantom.agent.preflight"]).toBe(1);
		expect(h.health.status).toBe("ok");
	});

	test("no bun degrades health; no phantom is informational", () => {
		expect(buildHandshake("1", { bun: false, phantom: true }).health).toEqual({
			status: "degraded",
			checks: [
				{ id: "bun-on-path", status: "missing" },
				{ id: "phantom-on-path", status: "ok" },
			],
		});
		const h = buildHandshake("1", { bun: true, phantom: false });
		expect(h.health.status).toBe("ok");
		expect(h.health.checks[1].status).toBe("absent");
	});

	test("ids are kebab-case and edits are home or project relative", () => {
		const h = buildHandshake("1", { bun: true, phantom: true });
		for (const id of [
			...h.capabilities,
			...h.health.checks.map((c: { id: string }) => c.id),
		]) {
			expect(id).toMatch(kebab);
		}
		expect(h.edits.every((p: string) => !p.startsWith("/"))).toBe(true);
	});

	test("only the exact flag asks for it", () => {
		expect(wantsHandshake(["--ashlr-handshake"])).toBe(true);
		expect(wantsHandshake(["doctor"])).toBe(false);
		expect(wantsHandshake(["--ashlr-handshake-x"])).toBe(false);
	});

	test("the npm launcher prints one JSON line with the package version", () => {
		const r = spawnSync(
			"node",
			[join(ROOT, "scripts", "ashlr-plugin.mjs"), "--ashlr-handshake"],
			{
				encoding: "utf8",
			},
		);
		expect(r.status).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		const h = JSON.parse(lines[0]);
		const pkg = JSON.parse(
			require("node:fs").readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		expect(h.kind).toBe("ashlr.handshake");
		expect(h.version).toBe(pkg.version);
	});
});
