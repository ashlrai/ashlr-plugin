/**
 * Ashlr companion detection for `ashlr doctor`: asks each installed companion
 * for `--ashlr-handshake --json` (docs/ashlr-handshake.md) and reports name,
 * version, capabilities and readiness. Same rules as `stack doctor --ecosystem`:
 * a short timeout per probe, an environment with no secrets, and a missing or
 * too-old companion is reported, never a failure.
 */

import { spawn } from "child_process";

export interface Companion {
	name: string;
	command: string;
	repo: string;
}

export const COMPANIONS: Companion[] = [
	{ name: "phantom", command: "phm", repo: "ashlrai/phantom" },
	{ name: "phantom-secrets", command: "phantom", repo: "ashlrai/phantom-secrets" },
	{ name: "locus", command: "locus", repo: "ashlrai/locus" },
	{ name: "lexicon", command: "lexicon", repo: "ashlrai/lexicon" },
	{ name: "ashlr-md", command: "mdopener-mcp", repo: "ashlrai/ashlr-md" },
	{ name: "ashlr-stack", command: "stack", repo: "ashlrai/ashlr-stack" },
];

export const COMPANION_TIMEOUT_MS = 2000;

export type CompanionRun =
	| { kind: "ran"; code: number | null; stdout: string }
	| { kind: "missing" }
	| { kind: "timeout" };

export type CompanionRunner = (
	command: string,
	timeoutMs: number,
) => Promise<CompanionRun>;

export interface CompanionResult {
	name: string;
	command: string;
	/** ready: answered v1 with health ok; degraded: answered, health not ok; outdated: no v1 answer; missing: not installed. */
	state: "ready" | "degraded" | "outdated" | "missing";
	version: string | null;
	capabilities: string[];
	fix: string | null;
}

/** PATH, HOME and locale only: no token in this process reaches a companion. */
export function companionEnv(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "PATHEXT"]) {
		const v = env[k];
		if (v !== undefined) out[k] = v;
	}
	out.NO_COLOR = "1";
	return out;
}

export const defaultCompanionRunner: CompanionRunner = (command, timeoutMs) =>
	new Promise((resolve) => {
		let stdout = "";
		let done = false;
		const finish = (r: CompanionRun) => {
			if (!done) {
				done = true;
				resolve(r);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, ["--ashlr-handshake", "--json"], {
				env: companionEnv(),
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish({ kind: "missing" });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ kind: "timeout" });
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			if (stdout.length < 64_000) stdout += String(d);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			finish(err.code === "ENOENT" ? { kind: "missing" } : { kind: "ran", code: 1, stdout: "" });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ kind: "ran", code, stdout });
		});
	});

export function parseCompanion(c: Companion, run: CompanionRun): CompanionResult {
	const base = { name: c.name, command: c.command, version: null, capabilities: [] as string[] };
	const docs = `https://github.com/${c.repo}#readme`;
	if (run.kind === "missing")
		return { ...base, state: "missing", fix: `optional: install ${c.name} (\`${c.command}\`), see ${docs}` };
	try {
		if (run.kind === "timeout") throw new Error("timeout");
		const v = JSON.parse(run.stdout.trim());
		if (v?.kind !== "ashlr.handshake" || v.schema_version !== 1) throw new Error("shape");
		const health = typeof v.health?.status === "string" ? v.health.status : "unknown";
		return {
			...base,
			state: health === "ok" ? "ready" : "degraded",
			version: typeof v.version === "string" ? v.version : null,
			capabilities: Array.isArray(v.capabilities)
				? v.capabilities.filter((x: unknown) => typeof x === "string")
				: [],
			fix: health === "ok" ? null : `run \`${c.command} --ashlr-handshake --json\` to see which check is not ok`,
		};
	} catch {
		return {
			...base,
			state: "outdated",
			fix: `upgrade ${c.name}: \`${c.command}\` does not answer --ashlr-handshake (see ${docs})`,
		};
	}
}

/** Probes every companion in parallel. Never throws. */
export async function detectCompanions(
	runner: CompanionRunner = defaultCompanionRunner,
	companions: Companion[] = COMPANIONS,
	timeoutMs = COMPANION_TIMEOUT_MS,
): Promise<CompanionResult[]> {
	return Promise.all(
		companions.map(async (c) =>
			parseCompanion(c, await runner(c.command, timeoutMs).catch((): CompanionRun => ({ kind: "missing" }))),
		),
	);
}
