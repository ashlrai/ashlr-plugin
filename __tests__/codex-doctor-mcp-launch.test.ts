/**
 * `codex-doctor` text output names whether `ashlr-mcp` (the command in the
 * plugin's .mcp.json) is on PATH, and gives the fix when it is not. The line
 * is report-only: the verdict and the --json report do not change with it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function emptyDir(): string {
	const d = mkdtempSync(join(tmpdir(), "codex-doctor-path-"));
	dirs.push(d);
	return d;
}

function dirWithStub(): string {
	const d = emptyDir();
	if (process.platform === "win32") {
		writeFileSync(join(d, "ashlr-mcp.cmd"), "@echo off\r\n");
	} else {
		const f = join(d, "ashlr-mcp");
		writeFileSync(f, "#!/bin/sh\nexit 0\n");
		chmodSync(f, 0o755);
	}
	return d;
}

async function doctor(pathDir: string, json = false): Promise<string> {
	const proc = Bun.spawn({
		cmd: [
			process.execPath,
			"run",
			"scripts/cli.ts",
			"codex-doctor",
			...(json ? ["--json"] : []),
		],
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PATH: pathDir, ASHLR_CONTEXT_DB_DISABLE: "1" },
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	expect(code).toBe(0);
	return out;
}

describe("codex-doctor MCP launch line", () => {
	test("names the fix when ashlr-mcp is not on PATH", async () => {
		const out = await doctor(emptyDir());
		expect(out).toContain("- MCP launch: ashlr-mcp is not on PATH");
		expect(out).toContain("npm install -g ashlr-plugin");
		expect(out).toContain(`bun run ${join(ROOT, "scripts", "ashlr-mcp.ts")}`);
	});

	test("says so when ashlr-mcp is on PATH", async () => {
		const out = await doctor(dirWithStub());
		expect(out).toContain("- MCP launch: ashlr-mcp is on PATH");
		expect(out).not.toContain("not on PATH");
	});

	test("is report-only: the verdict line and the --json ok are the same either way", async () => {
		const [absent, present] = [emptyDir(), dirWithStub()];
		const first = async (d: string) => (await doctor(d)).split("\n")[0];
		expect(await first(absent)).toBe(await first(present));
		const ok = async (d: string) =>
			(JSON.parse(await doctor(d, true)) as { ok: boolean }).ok;
		expect(await ok(absent)).toBe(await ok(present));
	});
});
