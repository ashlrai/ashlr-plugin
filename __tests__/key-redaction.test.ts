/**
 * No key value leaks through a gateway refusal or a network error.
 *
 * Every configured key variable gets a distinctive canary value. Every keyed
 * caller is then driven against each refusal shape (plain http off loopback,
 * localhost by name, credentials in the URL, another scheme, a key in the URL
 * query, strict mode with an unlisted host), and against each failure shape (a
 * closed port, a redirect, a 401 whose body echoes the request's headers, and
 * a 200 with a non-JSON body that contains the key). No 8-character window of
 * any key may appear in a thrown error, a return value, stdout, stderr or the
 * console. The Phantom proxy token in a base URL path is held to the same rule.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _hooks } from "../scripts/genome-auto-consolidate";
import { openaiRemoteEmbed } from "../servers/_embedding-model";
import { keyedFetch, safeKeyedFetch } from "../servers/_gateway-target";
import { anthropicProvider } from "../servers/_llm-providers/anthropic";
import {
	_resetCloudAvailabilityCache,
	cloudProvider,
} from "../servers/_llm-providers/cloud";
import { summarizeIfLarge } from "../servers/_llm-providers/index";
import {
	_resetLocalAvailabilityCache,
	localProvider,
} from "../servers/_llm-providers/local";
import { redactKnownKeys } from "../servers/_redact-keys";
import { measureTokens } from "../servers/_token-measure";
import { buildLLMShim } from "../servers/genome-server";
import { callLocalLLM } from "../servers/orient-server";

/** Distinctive canaries; the part after any generic prefix is what is searched for. */
const KEYS: Record<string, string> = {
	ASHLR_LLM_KEY: "llm-CANARYq7X2w9Z4k3M8vB",
	ANTHROPIC_API_KEY: "sk-ant-CANARYr5T1y8U2i6P0aS",
	OPENAI_API_KEY: "sk-CANARYd3F7g1H9j5K2lQxW",
	ASHLR_EMBED_KEY: "emb-CANARYl4Z6x0C2v7B9nMa",
	ASHLR_PRO_TOKEN: "pro-CANARYn1M5q9W3e7R2tYu",
	PHANTOM_PROXY_TOKEN: "ptokCANARYh8J3k6L1z4X7cVb",
};
const ENV_VARS = [
	...Object.keys(KEYS),
	"HOME",
	"ASHLR_LLM_URL",
	"ASHLR_API_URL",
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"ASHLR_EMBED_URL",
	"ASHLR_EMBED_FORMAT",
	"ASHLR_GATEWAY_STRICT",
	"ASHLR_GATEWAY_HOSTS",
	"ASHLR_LLM_PROVIDER",
	"ASHLR_GENOME_LLM_SYNTHESIS",
];

/** Every 8-character window of each key's distinctive part. */
const NEEDLES: string[] = Object.values(KEYS).flatMap((v) => {
	const tail = v.slice(v.indexOf("CANARY") + "CANARY".length);
	const out: string[] = [];
	for (let i = 0; i + 8 <= tail.length; i++) out.push(tail.slice(i, i + 8));
	return out;
});

function leaks(text: string): string[] {
	return NEEDLES.filter((n) => text.includes(n));
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

const captured: string[] = [];
const originals = {
	out: process.stdout.write.bind(process.stdout),
	err: process.stderr.write.bind(process.stderr),
	log: console.log,
	warn: console.warn,
	error: console.error,
	info: console.info,
	debug: console.debug,
};
function startCapture() {
	captured.length = 0;
	const grab = (chunk: unknown) => {
		captured.push(
			typeof chunk === "string"
				? chunk
				: Buffer.from(chunk as Uint8Array).toString(),
		);
		return true;
	};
	process.stdout.write = grab as typeof process.stdout.write;
	process.stderr.write = grab as typeof process.stderr.write;
	const c = (...a: unknown[]) => {
		captured.push(
			a
				.map((x) =>
					x instanceof Error ? `${x.message}\n${x.stack}` : String(x),
				)
				.join(" "),
		);
	};
	console.log = console.warn = console.error = console.info = console.debug = c;
}
function stopCapture() {
	process.stdout.write = originals.out as typeof process.stdout.write;
	process.stderr.write = originals.err as typeof process.stderr.write;
	Object.assign(console, {
		log: originals.log,
		warn: originals.warn,
		error: originals.error,
		info: originals.info,
		debug: originals.debug,
	});
}

/** Run `fn`, collecting its result or error and all output, as one string. */
async function observe(fn: () => Promise<unknown>): Promise<string> {
	const parts: string[] = [];
	startCapture();
	try {
		parts.push(JSON.stringify(await fn()) ?? "undefined");
	} catch (e) {
		const err = e as Error;
		parts.push(
			String(err),
			err?.message ?? "",
			err?.stack ?? "",
			JSON.stringify(err) ?? "",
		);
	} finally {
		stopCapture();
	}
	return [...parts, ...captured].join("\n");
}

// ---------------------------------------------------------------------------
// Stub targets
// ---------------------------------------------------------------------------

type Mode = "echo401" | "nonjson200" | "redirect";
let servers: ReturnType<typeof Bun.serve>[] = [];
const roots: Record<Mode, string> = {
	echo401: "",
	nonjson200: "",
	redirect: "",
};
const hits: Record<Mode, number> = { echo401: 0, nonjson200: 0, redirect: 0 };
let closedRoot = "";

beforeAll(() => {
	// Key-bearing headers first, as a gateway quoting the rejected credential would.
	const SECRET_HEADERS = [
		"authorization",
		"x-api-key",
		"x-openai",
		"x-embed",
		"x-pro",
	];
	const echoAll = (req: Request) =>
		[
			...SECRET_HEADERS.filter((h) => req.headers.has(h)).map(
				(h) => `${h}: ${req.headers.get(h)}`,
			),
			`path=${new URL(req.url).pathname}`,
		].join("; ");
	const mk = (mode: Mode) =>
		Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				await req.text().catch(() => "");
				hits[mode]++;
				if (mode === "redirect") {
					return new Response(null, {
						status: 302,
						headers: { location: `${roots.echo401}/stolen` },
					});
				}
				if (mode === "echo401") {
					return Response.json(
						{
							error: {
								type: "authentication_error",
								message: `Incorrect key ${echoAll(req)}`,
							},
						},
						{ status: 401 },
					);
				}
				return new Response(`${echoAll(req)} is not a model`, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
	for (const m of ["echo401", "nonjson200", "redirect"] as Mode[]) {
		const s = mk(m);
		servers.push(s);
		roots[m] = `http://127.0.0.1:${s.port}`;
	}
	const closed = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(""),
	});
	closedRoot = `http://127.0.0.1:${closed.port}`;
	closed.stop(true);
});

afterAll(() => {
	for (const s of servers) s.stop(true);
	servers = [];
});

/** Base URLs a keyed call is pointed at. `path` is appended to stub roots. */
function targets(
	path: string,
): Array<{ label: string; url: string; env?: Record<string, string> }> {
	const k = KEYS.ASHLR_LLM_KEY;
	const ptok = KEYS.PHANTOM_PROXY_TOKEN;
	return [
		{ label: "plain http off loopback", url: `http://10.1.2.3:9${path}` },
		{
			label: "localhost by name",
			url: `${roots.echo401.replace("127.0.0.1", "localhost")}${path}`,
		},
		{
			label: "credentials in the URL",
			url: `${roots.echo401.replace("http://", `http://user:${k}@`)}${path}`,
		},
		{ label: "another scheme", url: `ftp://gw.example.com${path}` },
		{
			label: "key in the URL query",
			url: `http://10.1.2.3:9${path}?api_key=${k}`,
		},
		{
			label: "strict mode, unlisted host",
			url: `https://unlisted.example.com${path}`,
			env: {
				ASHLR_GATEWAY_STRICT: "1",
				ASHLR_GATEWAY_HOSTS: "gw.example.com:443",
			},
		},
		{ label: "closed port", url: `${closedRoot}${path}` },
		{ label: "redirect", url: `${roots.redirect}/x/_phantom/${ptok}${path}` },
		{
			label: "401 echoing headers",
			url: `${roots.echo401}/x/_phantom/${ptok}${path}`,
		},
		{
			label: "200 with a non-JSON body",
			url: `${roots.nonjson200}/x/_phantom/${ptok}${path}`,
		},
	];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const saved: Record<string, string | undefined> = {};
let home = "";

beforeEach(() => {
	for (const v of ENV_VARS) saved[v] = process.env[v];
	for (const v of ENV_VARS) delete process.env[v];
	home = mkdtempSync(join(tmpdir(), "ashlr-redact-"));
	process.env.HOME = home;
	mkdirSync(join(home, ".ashlr"), { recursive: true });
	writeFileSync(join(home, ".ashlr", "pro-token"), KEYS.ASHLR_PRO_TOKEN);
	Object.assign(process.env, KEYS);
	_resetCloudAvailabilityCache();
	_resetLocalAvailabilityCache();
});

afterEach(() => {
	stopCapture();
	for (const v of ENV_VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
	rmSync(home, { recursive: true, force: true });
});

/** Callers, each pointed at `url` through its own variables. */
const CALLERS: Array<{
	name: string;
	path: string;
	run: (url: string) => Promise<unknown>;
}> = [
	{
		name: "safeKeyedFetch (every key in headers)",
		path: "/v1/messages",
		run: async (url) => {
			const res = await safeKeyedFetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${KEYS.ASHLR_LLM_KEY}`,
					"x-api-key": KEYS.ANTHROPIC_API_KEY,
					"x-openai": KEYS.OPENAI_API_KEY,
					"x-embed": KEYS.ASHLR_EMBED_KEY,
					"x-pro": KEYS.ASHLR_PRO_TOKEN,
				},
				body: "{}",
			});
			return { status: res.status };
		},
	},
	{
		name: "keyedFetch (strict mode helper)",
		path: "/v1/messages",
		run: async (url) => {
			const res = await keyedFetch(
				url,
				{ headers: { Authorization: `Bearer ${KEYS.ASHLR_LLM_KEY}` } },
				{ ...process.env, ASHLR_GATEWAY_STRICT: "1" },
			);
			return { status: res.status };
		},
	},
	{
		name: "anthropic summarizer",
		path: "",
		run: (url) => {
			process.env.ANTHROPIC_BASE_URL = url;
			return anthropicProvider.summarize("hello", "summarize");
		},
	},
	{
		name: "cloud provider (pro token)",
		path: "",
		run: (url) => {
			process.env.ASHLR_API_URL = url;
			return cloudProvider.summarize("hello", "summarize");
		},
	},
	{
		name: "local provider",
		path: "/v1",
		run: (url) => {
			process.env.ASHLR_LLM_URL = url;
			return localProvider.summarize("hello", "summarize");
		},
	},
	{
		name: "summarizeIfLarge (endpointOverride, stderr warning)",
		path: "/v1",
		run: (url) =>
			summarizeIfLarge("x".repeat(40_000), {
				toolName: "ashlr__read",
				systemPrompt: "summarize",
				endpointOverride: url,
				bypass: false,
			}),
	},
	{
		name: "orient callLocalLLM",
		path: "/v1",
		run: (url) => {
			process.env.ASHLR_LLM_URL = url;
			return callLocalLLM({
				systemPrompt: "s",
				userContent: "u",
				timeoutMs: 3000,
			} as never);
		},
	},
	{
		name: "genome consolidate shim",
		path: "/v1",
		run: async (url) => {
			process.env.ASHLR_LLM_URL = url;
			const events: unknown[] = [];
			for await (const ev of (
				buildLLMShim() as NonNullable<ReturnType<typeof buildLLMShim>>
			).stream({
				systemPrompt: "s",
				messages: [{ role: "user", content: "u" }],
			} as never)) {
				events.push(ev);
			}
			return events;
		},
	},
	{
		name: "token measurement",
		path: "",
		run: (url) => {
			process.env.ANTHROPIC_BASE_URL = url;
			return measureTokens(`unique text ${Math.random()}`);
		},
	},
	{
		name: "genome auto-consolidate probe (anthropic)",
		path: "",
		run: (url) => {
			delete process.env.ASHLR_LLM_URL;
			process.env.ANTHROPIC_BASE_URL = url;
			return _hooks.isLlmReachable();
		},
	},
	{
		name: "genome auto-consolidate probe (openai)",
		path: "/v1",
		run: (url) => {
			delete process.env.ASHLR_LLM_URL;
			delete process.env.ANTHROPIC_API_KEY;
			process.env.OPENAI_BASE_URL = url;
			return _hooks.isLlmReachable();
		},
	},
	{
		name: "openai-format embeddings",
		path: "/v1",
		run: (url) =>
			openaiRemoteEmbed("hello", {
				...process.env,
				ASHLR_EMBED_FORMAT: "openai",
				ASHLR_EMBED_URL: url,
			}),
	},
];

describe("no key value in any refusal or network-error output", () => {
	test("the canaries are distinctive and the needle check works", () => {
		expect(NEEDLES.length).toBeGreaterThan(40);
		expect(
			leaks(`x ${KEYS.ANTHROPIC_API_KEY.slice(-10)} y`).length,
		).toBeGreaterThan(0);
		expect(leaks("CANARY sk-ant- Bearer")).toEqual([]);
	});

	for (const caller of CALLERS) {
		test(caller.name, async () => {
			const found: string[] = [];
			const before = hits.echo401;
			for (const t of targets(caller.path)) {
				for (const v of ["ASHLR_GATEWAY_STRICT", "ASHLR_GATEWAY_HOSTS"])
					delete process.env[v];
				if (t.env) Object.assign(process.env, t.env);
				Object.assign(process.env, KEYS);
				_resetCloudAvailabilityCache();
				_resetLocalAvailabilityCache();
				const text = await observe(() => caller.run(t.url));
				const hit = leaks(text);
				if (hit.length > 0) found.push(`${t.label}: ${hit.length} window(s)`);
			}
			expect(found).toEqual([]);
			// Not vacuous: the caller reached the echoing stub with its key attached.
			expect(hits.echo401).toBeGreaterThan(before);
		}, 30_000);
	}
});

describe("redactKnownKeys", () => {
	const env = { ASHLR_LLM_KEY: "abcdEFGH1234ijklMNOP" } as NodeJS.ProcessEnv;

	test("replaces a whole key and a partial echo of it", () => {
		expect(redactKnownKeys("bad key abcdEFGH1234ijklMNOP!", [], env)).toBe(
			"bad key [redacted]!",
		);
		expect(redactKnownKeys("got ...1234ijklMN", [], env)).toBe(
			"got ...[redacted]",
		);
	});

	test("leaves short overlaps and unrelated text alone", () => {
		expect(redactKnownKeys("abcdEFG and MNOP", [], env)).toBe(
			"abcdEFG and MNOP",
		);
		expect(redactKnownKeys("nothing here", [], {})).toBe("nothing here");
	});

	test("covers extra values such as a token read from a file", () => {
		expect(
			redactKnownKeys("token zzzzYYYY9999 bad", ["zzzzYYYY9999"], {}),
		).toBe("token [redacted] bad");
	});

	test("ignores values too short to match safely", () => {
		expect(redactKnownKeys("a b c", ["a"], { OPENAI_API_KEY: "short" })).toBe(
			"a b c",
		);
	});
});
