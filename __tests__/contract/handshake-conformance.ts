/**
 * Reference checker for the Ashlr companion handshake v1 contract
 * (vendored from ashlr-stack packages/cli/src/lib, reformatted to this repo style; contract in __tests__/contract/). Dependency-free so other TypeScript
 * repos can vendor it next to the contract file. Returns a list of problems;
 * an empty list means the handshake conforms.
 */
export interface Contract {
	fields: Record<string, FieldRule>;
	health: {
		status: string[];
		check_id_pattern: string;
		check_status: string[];
		missing_means_not_ok: boolean;
	};
	gated_capabilities: Record<string, GatedCapability>;
	/** The `ashlr.doctor` v1 wrapper every tool's `doctor --json` carries. */
	doctor?: DoctorRules;
}
export interface DoctorRules {
	kind: string;
	schema_version: number;
	required: string[];
	status: string[];
	check_status: string[];
	check_required: string[];
	check_id_pattern: string;
}
export interface FieldRule {
	type: "string" | "integer" | "object" | "array";
	const?: string | number;
	pattern?: string;
	values?: "integer";
	required_keys?: string[];
	items?: "string";
	unique?: boolean;
	not_prefix?: string;
}
export interface GatedCapability {
	argv: string[];
	read_only: boolean;
	exit_codes: number[];
	stdout_json_keys: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export function checkHandshake(h: unknown, c: Contract): string[] {
	const out: string[] = [];
	if (!isObj(h)) return ["handshake is not a JSON object"];
	for (const [key, rule] of Object.entries(c.fields)) {
		const v = h[key];
		if (v === undefined) {
			out.push(`missing field ${key}`);
			continue;
		}
		if (rule.type === "string" && typeof v !== "string")
			out.push(`${key} must be a string`);
		if (rule.type === "integer" && !Number.isInteger(v))
			out.push(`${key} must be an integer`);
		if (rule.type === "object" && !isObj(v))
			out.push(`${key} must be an object`);
		if (rule.type === "array" && !Array.isArray(v))
			out.push(`${key} must be an array`);
		if (rule.const !== undefined && v !== rule.const)
			out.push(`${key} must be ${JSON.stringify(rule.const)}`);
		if (
			rule.pattern &&
			typeof v === "string" &&
			!new RegExp(rule.pattern).test(v)
		)
			out.push(`${key} does not match ${rule.pattern}`);
		if (isObj(v) && rule.values === "integer") {
			for (const [k, n] of Object.entries(v))
				if (!Number.isInteger(n)) out.push(`${key}.${k} must be an integer`);
		}
		if (isObj(v))
			for (const k of rule.required_keys ?? [])
				if (!(k in v)) out.push(`${key} must include ${k}`);
		if (Array.isArray(v)) {
			for (const item of v) {
				if (rule.items === "string" && typeof item !== "string")
					out.push(`${key} items must be strings`);
				else if (rule.pattern && !new RegExp(rule.pattern).test(item))
					out.push(
						`${key} item ${JSON.stringify(item)} does not match ${rule.pattern}`,
					);
				else if (rule.not_prefix && item.startsWith(rule.not_prefix))
					out.push(
						`${key} item ${JSON.stringify(item)} must not start with ${rule.not_prefix}`,
					);
			}
			if (rule.unique && new Set(v).size !== v.length)
				out.push(`${key} has duplicates`);
		}
	}
	const health = h.health;
	if (isObj(health)) {
		if (!c.health.status.includes(health.status as string))
			out.push(`health.status must be one of ${c.health.status.join(", ")}`);
		if (!Array.isArray(health.checks))
			out.push("health.checks must be an array");
		else {
			for (const ck of health.checks) {
				if (
					!isObj(ck) ||
					typeof ck.id !== "string" ||
					!new RegExp(c.health.check_id_pattern).test(ck.id)
				)
					out.push("health check id must be kebab-case");
				else if (!c.health.check_status.includes(ck.status as string))
					out.push(`health check ${ck.id} has status ${String(ck.status)}`);
			}
			if (
				c.health.missing_means_not_ok &&
				health.status === "ok" &&
				health.checks.some((ck) => isObj(ck) && ck.status === "missing")
			) {
				out.push("health.status is ok while a check is missing");
			}
		}
	}
	return out;
}

/** Gated capabilities this handshake advertises, with the argv each must accept. */
export function gatedFor(
	h: { capabilities?: unknown },
	c: Contract,
): Array<[string, GatedCapability]> {
	const caps = Array.isArray(h.capabilities) ? h.capabilities : [];
	return Object.entries(c.gated_capabilities).filter(([cap]) =>
		caps.includes(cap),
	);
}

/** Problems with one gated capability's run (exit code and stdout shape). */
export function checkGatedRun(
	cap: string,
	g: GatedCapability,
	status: number | null,
	stdout: string,
): string[] {
	const out: string[] = [];
	if (status === null || !g.exit_codes.includes(status))
		out.push(
			`${cap}: \`${g.argv.join(" ")}\` exited ${status}, expected ${g.exit_codes.join(" or ")}`,
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return [...out, `${cap}: \`${g.argv.join(" ")}\` did not print JSON`];
	}
	for (const k of g.stdout_json_keys)
		if (!isObj(parsed) || !(k in parsed)) out.push(`${cap}: output lacks ${k}`);
	return out;
}

/**
 * Problems with one `doctor --json` object under the `ashlr.doctor` v1
 * wrapper rules. The wrapper is additive: any other top-level or per-check
 * fields a tool already printed are allowed and ignored here.
 */
export function checkDoctor(d: unknown, c: Contract): string[] {
	const r = c.doctor;
	if (!r) return ["contract has no doctor rules"];
	if (!isObj(d)) return ["doctor output is not a JSON object"];
	const out: string[] = [];
	for (const k of r.required) if (!(k in d)) out.push(`missing field ${k}`);
	if ("kind" in d && d.kind !== r.kind) out.push(`kind must be ${r.kind}`);
	if ("schema_version" in d && d.schema_version !== r.schema_version)
		out.push(`schema_version must be ${r.schema_version}`);
	if (
		"tool" in d &&
		(typeof d.tool !== "string" || !new RegExp(r.check_id_pattern).test(d.tool))
	)
		out.push("tool must be a kebab-case string");
	if ("status" in d && !r.status.includes(d.status as string))
		out.push(`status must be one of ${r.status.join(", ")}`);
	if ("native_status" in d && typeof d.native_status !== "string")
		out.push("native_status must be a string");
	if ("checks" in d) {
		if (!Array.isArray(d.checks)) out.push("checks must be an array");
		else
			d.checks.forEach((ck, i) => {
				if (!isObj(ck)) {
					out.push(`checks[${i}] is not an object`);
					return;
				}
				for (const k of r.check_required)
					if (!(k in ck)) out.push(`checks[${i}] missing ${k}`);
				if ("status" in ck && !r.check_status.includes(ck.status as string))
					out.push(
						`checks[${i}].status must be one of ${r.check_status.join(", ")}`,
					);
				if ("summary" in ck && typeof ck.summary !== "string")
					out.push(`checks[${i}].summary must be a string`);
				if (
					"id" in ck &&
					(typeof ck.id !== "string" ||
						!new RegExp(r.check_id_pattern).test(ck.id))
				)
					out.push(`checks[${i}].id must be kebab-case`);
			});
	}
	// A check that failed cannot sit under an ok or warn top-level status.
	if (
		Array.isArray(d.checks) &&
		d.status !== "fail" &&
		d.checks.some((ck) => isObj(ck) && ck.status === "fail")
	)
		out.push("a check is fail but status is not fail");
	return out;
}
