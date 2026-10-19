/**
 * Strip key material from text that came back from a model endpoint before it
 * reaches an error message, a log line or stderr.
 *
 * A gateway that rejects a credential may quote it back in its error body,
 * whole or in part. Any run of 8 or more characters that also appears inside
 * a configured key is replaced with "[redacted]".
 */

/** Environment variables that can hold key material for a model endpoint. */
export const KEY_ENV_VARS = [
	"ASHLR_LLM_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"ASHLR_EMBED_KEY",
	"ASHLR_PRO_TOKEN",
	"PHANTOM_PROXY_TOKEN",
] as const;

const WINDOW = 8;

/**
 * Redact every run of `WINDOW` or more characters of `text` that also occurs
 * inside one of the configured key values or one of `extra`.
 */
export function redactKnownKeys(
	text: string,
	extra: Array<string | null | undefined> = [],
	env: NodeJS.ProcessEnv = process.env,
): string {
	const secrets = [...KEY_ENV_VARS.map((v) => env[v]), ...extra].filter(
		(s): s is string => typeof s === "string" && s.trim().length >= WINDOW,
	);
	if (secrets.length === 0 || text.length < WINDOW) return text;

	const windows = new Set<string>();
	for (const s of secrets) {
		for (let i = 0; i + WINDOW <= s.length; i++)
			windows.add(s.slice(i, i + WINDOW));
	}

	const covered = new Uint8Array(text.length);
	let any = false;
	for (let i = 0; i + WINDOW <= text.length; i++) {
		if (windows.has(text.slice(i, i + WINDOW))) {
			covered.fill(1, i, i + WINDOW);
			any = true;
		}
	}
	if (!any) return text;

	let out = "";
	for (let i = 0; i < text.length; ) {
		if (covered[i]) {
			while (i < text.length && covered[i]) i++;
			out += "[redacted]";
		} else {
			out += text[i++];
		}
	}
	return out;
}

/**
 * Read a failed response's body for an error message: bounded, redacted, then
 * cut to `max` characters.
 */
export async function redactedBody(
	res: Response,
	extra: Array<string | null | undefined> = [],
	max = 200,
): Promise<string> {
	const raw = await res.text().catch(() => "");
	return redactKnownKeys(raw.slice(0, 4096), extra).slice(0, max);
}
