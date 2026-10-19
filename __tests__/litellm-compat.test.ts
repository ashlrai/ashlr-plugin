/**
 * LiteLLM compatibility, hermetic: a fake LiteLLM-shaped proxy on 127.0.0.1
 * (port 0, no network). For each keyed provider path it asserts
 *   (a) the configured base URL is honored,
 *   (b) the request path is the one LiteLLM serves,
 *   (c) only the configured key (or a phm_ placeholder) is sent; canary keys
 *       in every other key variable, and a canary Claude Code OAuth token,
 *       never reach the proxy.
 * The leak detector itself is proven red with an injected leak.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Seen = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
};

const CANARIES: Record<string, string> = {
	ANTHROPIC_API_KEY: "sk-ant-CANARY-anthropic-0001",
	OPENAI_API_KEY: "sk-CANARY-openai-0002",
	ASHLR_LLM_KEY: "CANARY-ashlr-llm-0003",
	ASHLR_PRO_TOKEN: "CANARY-ashlr-pro-0004",
	ASHLR_EMBED_KEY: "CANARY-ashlr-embed-0005",
	ASHLR_API_KEY: "CANARY-ashlr-api-0006",
	GEMINI_API_KEY: "CANARY-gemini-0007",
};
const OAUTH_CANARY = "CANARY-claude-oauth-0008";
const ENV_KEYS = [
	...Object.keys(CANARIES),
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"ASHLR_LLM_URL",
	"ASHLR_API_URL",
	"ASHLR_EMBED_URL",
	"ASHLR_EMBED_FORMAT",
	"ASHLR_GATEWAY_STRICT",
	"HOME",
];

let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let home = "";
const saved: Record<string, string | undefined> = {};

/** Fails if any secret other than `allowed` appears in any header or the body. */
export function assertOnlyKey(
	req: Seen,
	allowed: string,
	others: string[],
): void {
	const blob = `${Object.entries(req.headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n")}\n${req.body}`;
	for (const other of others) {
		if (other !== allowed && blob.includes(other)) {
			throw new Error(
				`leak: a non-configured key reached the proxy at ${req.path}`,
			);
		}
	}
}

function allOthers(): string[] {
	return [...Object.values(CANARIES), OAUTH_CANARY];
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			seen.push({
				method: req.method,
				path: url.pathname,
				headers,
				body: await req.text(),
			});
			if (url.pathname === "/v1/messages") {
				return Response.json({
					content: [{ type: "text", text: "ok" }],
					usage: { input_tokens: 7, output_tokens: 1 },
				});
			}
			if (url.pathname === "/v1/chat/completions") {
				return Response.json({
					choices: [{ message: { content: "ok" } }],
					usage: { prompt_tokens: 7, completion_tokens: 1 },
				});
			}
			if (url.pathname === "/v1/embeddings") {
				return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
			}
			return new Response("not found", { status: 404 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
	seen = [];
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const [k, v] of Object.entries(CANARIES)) process.env[k] = v;
	for (const k of [
		"ANTHROPIC_BASE_URL",
		"OPENAI_BASE_URL",
		"ASHLR_LLM_URL",
		"ASHLR_API_URL",
		"ASHLR_EMBED_URL",
		"ASHLR_EMBED_FORMAT",
		"ASHLR_GATEWAY_STRICT",
	]) {
		delete process.env[k];
	}
	home = mkdtempSync(join(tmpdir(), "litellm-compat-"));
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: OAUTH_CANARY } }),
	);
	process.env.HOME = home;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(home, { recursive: true, force: true });
});

describe("leak detector", () => {
	it("is red when a non-configured key is injected into a request", async () => {
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: "Bearer sk-litellm-configured",
				"x-extra": CANARIES.OPENAI_API_KEY!,
			},
			body: "{}",
		});
		await res.text();
		expect(() =>
			assertOnlyKey(seen[0]!, "sk-litellm-configured", allOthers()),
		).toThrow(/leak/);
	});
	it("is green for a request that carries only the configured key", async () => {
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { Authorization: "Bearer sk-litellm-configured" },
			body: "{}",
		});
		await res.text();
		expect(() =>
			assertOnlyKey(seen[0]!, "sk-litellm-configured", allOthers()),
		).not.toThrow();
	});
});

describe("LiteLLM-shaped proxy on loopback", () => {
	it("anthropic summarize: ANTHROPIC_BASE_URL honored, POST /v1/messages, only ANTHROPIC_API_KEY", async () => {
		process.env.ANTHROPIC_BASE_URL = base;
		const { anthropicProvider } = await import(
			"../servers/_llm-providers/anthropic.ts"
		);
		const r = await anthropicProvider.summarize("hello", "summarize");
		expect(r.output).toBe("ok");
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /v1/messages",
		]);
		expect(seen[0]!.headers["x-api-key"]).toBe(CANARIES.ANTHROPIC_API_KEY);
		assertOnlyKey(seen[0]!, CANARIES.ANTHROPIC_API_KEY!, allOthers());
	});

	it("anthropic summarize with a phm_ placeholder sends the placeholder and nothing else", async () => {
		process.env.ANTHROPIC_BASE_URL = base;
		process.env.ANTHROPIC_API_KEY = "phm_session_placeholder_abc";
		const { anthropicProvider } = await import(
			"../servers/_llm-providers/anthropic.ts"
		);
		await anthropicProvider.summarize("hello", "summarize");
		expect(seen[0]!.headers["x-api-key"]).toBe("phm_session_placeholder_abc");
		assertOnlyKey(seen[0]!, "phm_session_placeholder_abc", allOthers());
	});

	it("anthropic summarize with a gateway base URL and no ANTHROPIC_API_KEY never sends the Claude Code OAuth token", async () => {
		process.env.ANTHROPIC_BASE_URL = base;
		delete process.env.ANTHROPIC_API_KEY;
		const { anthropicProvider } = await import(
			"../servers/_llm-providers/anthropic.ts"
		);
		await anthropicProvider
			.summarize("hello", "summarize")
			.catch(() => undefined);
		for (const s of seen) assertOnlyKey(s, "", allOthers());
	});

	it("token measurement: POST /v1/messages on the configured base, only ANTHROPIC_API_KEY", async () => {
		process.env.ANTHROPIC_BASE_URL = base;
		const { measureTokens } = await import("../servers/_token-measure.ts");
		expect(await measureTokens(`litellm-compat ${Date.now()}`)).toBe(7);
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /v1/messages",
		]);
		assertOnlyKey(seen[0]!, CANARIES.ANTHROPIC_API_KEY!, allOthers());
	});

	it("local provider: ASHLR_LLM_URL=<proxy>/v1 honored, POST /v1/chat/completions, only ASHLR_LLM_KEY", async () => {
		process.env.ASHLR_LLM_URL = `${base}/v1`;
		process.env.ASHLR_LLM_KEY = "sk-litellm-virtual-key";
		const { localProvider } = await import(
			"../servers/_llm-providers/local.ts"
		);
		expect((await localProvider.summarize("hello", "summarize")).output).toBe(
			"ok",
		);
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /v1/chat/completions",
		]);
		expect(seen[0]!.headers.authorization).toBe(
			"Bearer sk-litellm-virtual-key",
		);
		assertOnlyKey(seen[0]!, "sk-litellm-virtual-key", allOthers());
	});

	it("openai-format embeddings: ASHLR_EMBED_URL=<proxy>/v1 honored, POST /v1/embeddings, only ASHLR_EMBED_KEY", async () => {
		const { openaiRemoteEmbed } = await import(
			"../servers/_embedding-model.ts"
		);
		const env = {
			...process.env,
			ASHLR_EMBED_URL: `${base}/v1`,
			ASHLR_EMBED_FORMAT: "openai",
			ASHLR_EMBED_KEY: "sk-litellm-embed",
		};
		const v = await openaiRemoteEmbed("hello", env);
		expect(v).not.toBeNull();
		expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /v1/embeddings",
		]);
		expect(seen[0]!.headers.authorization).toBe("Bearer sk-litellm-embed");
		assertOnlyKey(seen[0]!, "sk-litellm-embed", allOthers());
	});
});
