/**
 * Handshake conformance kit: validates `ashlr-plugin --ashlr-handshake`
 * against the Ashlr handshake v1 contract vendored from ashlr-stack
 * (__tests__/contract/, pinned by sha256, no network fetch), and runs the
 * argv mapped to every gated capability the plugin advertises.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: plain .mjs module without types
import { buildHandshake } from "../scripts/handshake.mjs";
import {
	type Contract,
	checkHandshake,
	gatedFor,
} from "./contract/handshake-conformance.ts";

const ROOT = join(import.meta.dir, "..");
const PINNED_SHA256 =
	"e4fa6e79ae7523fb11c44fc16843f0edf385f6c8e4c164409a62d05a76e0ac95";
const contractPath = join(
	import.meta.dir,
	"contract",
	"ashlr-handshake.v1.json",
);
const raw = readFileSync(contractPath);
const contract = JSON.parse(raw.toString("utf8")) as Contract;

describe("handshake contract v1 conformance", () => {
	test("the vendored contract matches its pin", () => {
		const sha = createHash("sha256").update(raw).digest("hex");
		expect(sha).toBe(PINNED_SHA256);
		expect(readFileSync(`${contractPath}.sha256`, "utf8").split(/\s+/)[0]).toBe(
			sha,
		);
	});

	test("`ashlr-plugin --ashlr-handshake --json` conforms", () => {
		const home = mkdtempSync(join(tmpdir(), "ashlr-conformance-"));
		// Only PATH and HOME: no tokens reach the probe.
		const r = spawnSync(
			"node",
			[
				join(ROOT, "scripts", "ashlr-plugin.mjs"),
				"--ashlr-handshake",
				"--json",
			],
			{ encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } },
		);
		expect(r.status).toBe(0);
		const h = JSON.parse(r.stdout.trim());
		expect(checkHandshake(h, contract)).toEqual([]);
		// The plugin advertises no gated capability (it has `doctor`, not
		// `doctor-fix`). If it ever does, its contract argv must be run here.
		expect(gatedFor(h, contract)).toEqual([]);
	});

	test("every health combination conforms", () => {
		for (const bun of [true, false]) {
			for (const phantom of [true, false]) {
				expect(
					checkHandshake(buildHandshake("1.2.3", { bun, phantom }), contract),
				).toEqual([]);
			}
		}
	});
});
