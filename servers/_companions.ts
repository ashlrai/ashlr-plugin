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
	{
		name: "phantom-secrets",
		command: "phantom",
		repo: "ashlrai/phantom-secrets",
	},
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
	/**
	 * ready: answered v1 with health ok; degraded: answered, health not ok;
	 * outdated: ran but printed no JSON (too old for the handshake);
	 * unknown: timed out, or printed JSON that is not a v1 handshake;
	 * missing: not installed.
	 */
	state: "ready" | "degraded" | "outdated" | "unknown" | "missing";
	version: string | null;
	capabilities: string[];
	/** The handshake's health.status as reported, or null when there was no v1 answer. */
	health: string | null;
	fix: string | null;
	/** Capability-gated commands to run next (same rules as `stack doctor --ecosystem`). */
	next_steps: string[];
}

/** Handshake capability a companion advertises when `<command> doctor --fix` exists. */
export const DOCTOR_FIX_CAPABILITY = "doctor-fix";
/** Kept for callers of #218. */
export const LOCUS_DOCTOR_FIX_CAPABILITY = DOCTOR_FIX_CAPABILITY;

/**
 * Companions whose `doctor --fix` is a safe dry run by default (writes
 * nothing; `--apply` makes the repairs). Keyed by companion name, valued by
 * the command the user runs.
 */
export const DOCTOR_FIX_COMMANDS: Record<string, string> = {
	locus: "locus",
	lexicon: "lexicon",
	"ashlr-md": "mdopener-mcp",
};

export const doctorFixStep = (command: string): string =>
	`${command} doctor --fix   # preview safe repairs (writes nothing); add --apply to make them`;

export const LOCUS_DOCTOR_FIX_STEP = doctorFixStep("locus");
export const LEXICON_DOCTOR_FIX_STEP = doctorFixStep("lexicon");
export const MDOPENER_DOCTOR_FIX_STEP = doctorFixStep("mdopener-mcp");

/**
 * Next steps for one companion. Keyed on what the companion itself
 * advertises, never on its version: `<command> doctor --fix` only when the
 * companion is one of DOCTOR_FIX_COMMANDS, answered, its health is not ok,
 * and it lists `doctor-fix`.
 */
export function companionNextSteps(
	r: Pick<CompanionResult, "name" | "state" | "health" | "capabilities">,
): string[] {
	const command = new Map(Object.entries(DOCTOR_FIX_COMMANDS)).get(r.name);
	if (
		command !== undefined &&
		r.state === "degraded" &&
		r.health !== null &&
		r.health !== "ok" &&
		r.capabilities.includes(DOCTOR_FIX_CAPABILITY)
	)
		return [doctorFixStep(command)];
	return [];
}

/** PATH, HOME and locale only: no token in this process reaches a companion. */
export function companionEnv(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of [
		"PATH",
		"HOME",
		"USER",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"SYSTEMROOT",
		"PATHEXT",
	]) {
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
			finish(
				err.code === "ENOENT"
					? { kind: "missing" }
					: { kind: "ran", code: 1, stdout: "" },
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ kind: "ran", code, stdout });
		});
	});

export function parseCompanion(
	c: Companion,
	run: CompanionRun,
): CompanionResult {
	const base = {
		name: c.name,
		command: c.command,
		version: null,
		capabilities: [] as string[],
		health: null,
		next_steps: [] as string[],
	};
	const docs = `https://github.com/${c.repo}#readme`;
	if (run.kind === "missing")
		return {
			...base,
			state: "missing",
			fix: `optional: install ${c.name} (\`${c.command}\`), see ${docs}`,
		};
	if (run.kind === "timeout")
		return {
			...base,
			state: "unknown",
			fix: `\`${c.command} --ashlr-handshake --json\` did not answer in time`,
		};
	const text = run.stdout.trim();
	let v: unknown;
	let parsed = true;
	try {
		v = JSON.parse(text);
	} catch {
		parsed = false;
	}
	// Not JSON at all: an older build that does not know the flag.
	if (!parsed && !text.startsWith("{"))
		return {
			...base,
			state: "outdated",
			fix: `upgrade ${c.name}: \`${c.command}\` does not answer --ashlr-handshake (see ${docs})`,
		};
	if (!parsed || v === null || typeof v !== "object")
		return {
			...base,
			state: "unknown",
			fix: `\`${c.command} --ashlr-handshake --json\` printed output doctor cannot read`,
		};
	const h = v as Record<string, unknown> & { health?: { status?: unknown } };
	if (h.kind !== "ashlr.handshake" || h.schema_version !== 1)
		return {
			...base,
			state: "unknown",
			fix: `\`${c.command} --ashlr-handshake --json\` printed output doctor cannot read`,
		};
	const health =
		typeof h.health?.status === "string" ? h.health.status : "unknown";
	const result: CompanionResult = {
		...base,
		state: health === "ok" ? "ready" : "degraded",
		version: typeof h.version === "string" ? h.version : null,
		capabilities: Array.isArray(h.capabilities)
			? h.capabilities.filter((x): x is string => typeof x === "string")
			: [],
		health,
		fix:
			health === "ok"
				? null
				: `run \`${c.command} --ashlr-handshake --json\` to see which check is not ok`,
	};
	result.next_steps = companionNextSteps(result);
	if (result.next_steps.length)
		result.fix = `run \`${DOCTOR_FIX_COMMANDS[c.name]} doctor --fix\` to preview safe repairs (writes nothing); add --apply to make them`;
	return result;
}

/** Probes every companion in parallel. Never throws. */
export async function detectCompanions(
	runner: CompanionRunner = defaultCompanionRunner,
	companions: Companion[] = COMPANIONS,
	timeoutMs = COMPANION_TIMEOUT_MS,
): Promise<CompanionResult[]> {
	return Promise.all(
		companions.map(async (c) =>
			parseCompanion(
				c,
				await runner(c.command, timeoutMs).catch(
					(): CompanionRun => ({ kind: "missing" }),
				),
			),
		),
	);
}
