/**
 * Opt-in Phantom agent preflight for `ashlr doctor`, following phantom-secrets
 * docs/agent-preflight-contract.md (schema_version 1). It runs
 * `phantom agent doctor --json --strict`, which reads only project files and
 * environment variables (no vault, no keychain) and prints a value-free
 * verdict. `--strict` exits 0 ready, 2 degraded, 1 blocked, 3 could not
 * evaluate.
 *
 * Off unless ASHLR_PHANTOM_PREFLIGHT is set:
 *   1 / true / on  blocked is a fail; degraded or unknown is a warning
 *   strict         anything but ready is a fail
 * A missing phantom, or one without `agent doctor --json`, is only a warning.
 * Output is the verdict and kebab-case check ids; never names or values.
 */

import { spawnSync } from "child_process";

export type PreflightMode = "off" | "on" | "strict";
export type Verdict = "ready" | "degraded" | "blocked" | "unknown";
export type PreflightRunner = () => {
	status: number | null;
	stdout: string;
	missing: boolean;
};

export interface PreflightResult {
	status: "ok" | "warn" | "fail";
	verdict: Verdict | null;
	/** Ids of the critical checks (`wrap.blocked_by`). Ids only. */
	blockedBy: string[];
	detail: string;
}

export function preflightMode(
	env: Record<string, string | undefined> = process.env,
): PreflightMode {
	const v = (env["ASHLR_PHANTOM_PREFLIGHT"] ?? "").trim().toLowerCase();
	if (v === "strict") return "strict";
	if (v === "1" || v === "true" || v === "on") return "on";
	return "off";
}

export const defaultPreflightRunner: PreflightRunner = () => {
	try {
		const r = spawnSync("phantom", ["agent", "doctor", "--json", "--strict"], {
			encoding: "utf8",
			timeout: 15_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		// Some Bun versions set `error` on a normal exit, so trust `status` first.
		const missing =
			r.status === null &&
			(r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
		return { status: r.status ?? null, stdout: r.stdout ?? "", missing };
	} catch {
		return { status: null, stdout: "", missing: true };
	}
};

const EXIT_CODES = new Set([0, 1, 2, 3]);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERDICTS: readonly Verdict[] = [
	"ready",
	"degraded",
	"blocked",
	"unknown",
];

function parse(
	stdout: string,
): { verdict: Verdict; blockedBy: string[] } | null {
	try {
		const doc = JSON.parse(stdout) as {
			schema_version?: unknown;
			kind?: unknown;
			verdict?: unknown;
			wrap?: { blocked_by?: unknown };
		};
		if (doc.kind !== "phantom.agent.preflight" || doc.schema_version !== 1)
			return null;
		if (!VERDICTS.includes(doc.verdict as Verdict)) return null;
		const ids = Array.isArray(doc.wrap?.blocked_by) ? doc.wrap.blocked_by : [];
		const blockedBy = ids.filter(
			(id): id is string => typeof id === "string" && ID.test(id),
		);
		return { verdict: doc.verdict as Verdict, blockedBy };
	} catch {
		return null;
	}
}

/** Run the preflight; null when it is off. */
export function runPhantomPreflight(
	mode: PreflightMode,
	run: PreflightRunner = defaultPreflightRunner,
): PreflightResult | null {
	if (mode === "off") return null;
	const r = run();
	if (r.missing) {
		return {
			status: "warn",
			verdict: null,
			blockedBy: [],
			detail: "skipped: phantom is not installed",
		};
	}
	const parsed = parse(r.stdout);
	if (!parsed || r.status === null || !EXIT_CODES.has(r.status)) {
		return {
			status: "warn",
			verdict: null,
			blockedBy: [],
			detail: "skipped: this phantom has no `agent doctor --json` (schema 1)",
		};
	}
	const { verdict, blockedBy } = parsed;
	const status =
		verdict === "ready"
			? "ok"
			: verdict === "blocked" || mode === "strict"
				? "fail"
				: "warn";
	const ids = blockedBy.length ? ` (${blockedBy.join(", ")})` : "";
	return {
		status,
		verdict,
		blockedBy,
		detail: `${verdict}${verdict === "blocked" ? ids : ""}`,
	};
}
