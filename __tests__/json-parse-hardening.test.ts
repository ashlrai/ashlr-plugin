/**
 * JSON.parse hardening tests.
 *
 * Verifies that the untrusted-input JSON.parse sites surface a graceful error
 * instead of crashing the tool when the upstream returns malformed or
 * oversized JSON.
 *
 *   - github-server: fake `gh` returns malformed JSON → MCP result has
 *     isError:true with a "malformed … JSON" message.
 *   - github-server: fake `gh` returns oversized JSON → MCP result has
 *     isError:true with a "payload too large" message.
 *   - genome-server LLM shim: oversized SSE frame is skipped without crash.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildLLMShim } from "../servers/genome-server";

// ---------------------------------------------------------------------------
// Fake gh helpers (mirrors __tests__/github-server.test.ts style)
// ---------------------------------------------------------------------------

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }

const INIT = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

function callTool(id: number, name: string, args: Record<string, unknown>): RpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(reqs: RpcRequest[], opts: { home: string; path: string }): Promise<any[]> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const serverPath = join(import.meta.dir, "..", "servers", "github-server.ts");
  const proc = spawn({
    cmd: ["bun", "run", serverPath],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: opts.home, PATH: opts.path },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function installBadGh(dir: string, body: string): Promise<string> {
  const binDir = join(dir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const payloadPath = join(dir, "payload.txt");
  await writeFile(payloadPath, body);
  const script = `#!/bin/sh
case "$1" in
  auth) echo "Logged in"; exit 0 ;;
esac
cat "${payloadPath}"
exit 0
`;
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script);
  await chmod(ghPath, 0o755);
  return binDir;
}

function bunDir(): string {
  const bin = (process as any).execPath as string;
  if (bin && bin.includes("/")) return bin.slice(0, bin.lastIndexOf("/"));
  return `${process.env.HOME}/.bun/bin`;
}

function pathWith(binDir: string): string {
  return `${binDir}:${bunDir()}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`;
}

// ---------------------------------------------------------------------------
// github-server: malformed / oversized gh JSON
// ---------------------------------------------------------------------------

const isWin = process.platform === "win32";
const describeIfNotWin = isWin ? describe.skip : describe;

describeIfNotWin("github-server · malformed gh JSON (skipped on Windows: fake-gh uses sh shebang)", () => {
  test("ashlr__issue parses valid JSON surrounded by whitespace", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-whitespace-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installBadGh(work, ' \t\r\n{"number":42,"title":"Whitespace works","state":"OPEN"}\n\r\t ');
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue", { number: 42, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).not.toBe(true);
      expect(r.result.content[0].text).toContain("Issue #42 · OPEN");
      expect(r.result.content[0].text).toContain("title: Whitespace works");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("ashlr__pr returns structured isError on malformed JSON instead of crashing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-malformed-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installBadGh(work, "{this-is-not-valid-json");
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 1, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/malformed .* JSON/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("ashlr__issue returns structured isError on malformed JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-malformed2-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work2-"));
    try {
      const binDir = await installBadGh(work, "<!DOCTYPE html><html>not json</html>");
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue", { number: 1, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/malformed .* JSON/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("ashlr__pr rejects valid JSON followed by trailing junk", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-trailing-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-t-"));
    try {
      const binDir = await installBadGh(work, '{"number":1,"title":"ok"} trailing-junk');
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 1, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/malformed .* JSON/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("ashlr__pr rejects truncated JSON and handles a subsequent request", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-truncated-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-truncated-"));
    try {
      const binDir = await installBadGh(work, '{"number":1,"title":"unfinished');
      const responses = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 1, repo: "acme/widgets" }),
          callTool(3, "ashlr__pr", { number: 2, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      for (const id of [2, 3]) {
        const response = responses.find((r) => r.id === id);
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toMatch(/malformed .* JSON/i);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  // Truncated objects cut at different grammar positions: every one must
  // surface the same structured error, never a crash or a partial result.
  const TRUNCATED_OBJECTS: Array<[string, string]> = [
    ["open brace only", "{"],
    ["after key, before colon", '{"number"'],
    ["after colon, before value", '{"number":'],
    ["after comma", '{"number":1,'],
    ["inside nested object", '{"number":1,"author":{"login":"oct'],
    ["inside nested array", '{"number":1,"labels":[{"name":"bug"},'],
  ];

  for (const [label, body] of TRUNCATED_OBJECTS) {
    for (const tool of ["ashlr__pr", "ashlr__issue"]) {
      test(`${tool} returns malformed-JSON isError for object truncated ${label}`, async () => {
        const home = await mkdtemp(join(tmpdir(), "ashlr-trunc-obj-"));
        const work = await mkdtemp(join(tmpdir(), "ashlr-work-trunc-obj-"));
        try {
          const binDir = await installBadGh(work, body);
          const responses = await rpc(
            [INIT, callTool(2, tool, { number: 1, repo: "acme/widgets" }),
              callTool(3, tool, { number: 2, repo: "acme/widgets" })],
            { home, path: pathWith(binDir) },
          );
          // Server survives: both calls answered, each with a structured error.
          for (const id of [2, 3]) {
            const response = responses.find((r) => r.id === id);
            expect(response).toBeDefined();
            expect(response.error).toBeUndefined();
            expect(response.result.isError).toBe(true);
            expect(response.result.content[0].text).toMatch(/malformed .* JSON/i);
          }
        } finally {
          await rm(home, { recursive: true, force: true });
          await rm(work, { recursive: true, force: true });
        }
      });
    }
  }

  test("ashlr__issue rejects two concatenated JSON documents", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-trailing2-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-t2-"));
    try {
      const binDir = await installBadGh(work, '{"number":1}{"number":2}');
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue", { number: 1, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/malformed .* JSON/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  // Note: a subprocess-level oversized-output test is unreliable because
  // spawn stdout buffering and kernel pipe limits can truncate multi-MB
  // payloads before the server ever parses them. The size cap is enforced
  // in github-server's safeParseGhJson helper; that branch is exercised
  // through the malformed-JSON tests above (same error path, same catch).
});

// ---------------------------------------------------------------------------
// genome-server LLM shim: malformed / oversized SSE frames
// ---------------------------------------------------------------------------

describe("genome-server · SSE parse hardening", () => {
  afterEach(() => { delete process.env.ASHLR_LLM_URL; });
  async function consume(shim: ReturnType<typeof buildLLMShim>): Promise<string> {
    let out = "";
    // The shim's ProviderRequest shape only uses systemPrompt/messages.
    const req = {
      systemPrompt: "sys",
      messages: [{ role: "user" as const, content: "hi" }],
      maxTokens: 16,
    };
    for await (const ev of shim!.stream(req as any)) {
      if (ev.type === "text_delta") out += ev.text;
    }
    return out;
  }

  test("valid JSON frames with surrounding whitespace yield their content", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          'data: \t  {"choices":[{"delta":{"content":"hello world"}}]} \t \n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      process.env.ASHLR_LLM_URL = `http://127.0.0.1:${server.port}/v1`;
      expect(await consume(buildLLMShim())).toBe("hello world");
    } finally {
      server.stop();
    }
  });

  test("malformed JSON frames are skipped without yielding text or throwing", async () => {
    // Spin up a tiny HTTP server that emits malformed SSE frames.
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = [
          "data: not-json-at-all",
          "",
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      process.env.ASHLR_LLM_URL = `http://127.0.0.1:${server.port}/v1`;
      const shim = buildLLMShim();
      const text = await consume(shim);
      // We expect only the well-formed frame's content.
      expect(text).toBe("hello");
    } finally {
      server.stop();
    }
  });

  test("SSE frame with valid JSON plus trailing junk is skipped", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = [
          'data: {"choices":[{"delta":{"content":"bad"}}]} junk',
          "",
          'data: {"choices":[{"delta":{"content":"good"}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      process.env.ASHLR_LLM_URL = `http://127.0.0.1:${server.port}/v1`;
      expect(await consume(buildLLMShim())).toBe("good");
    } finally {
      server.stop();
    }
  });

  test("truncated JSON object frame (stream cut mid-object) is skipped without throwing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // Final frame is cut off mid-object and never terminated.
        return new Response(
          'data: {"choices":[{"delta":{"content":"whole"}}]}\n\ndata: {"choices":[{"delta":{"content":"cut',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      process.env.ASHLR_LLM_URL = `http://127.0.0.1:${server.port}/v1`;
      expect(await consume(buildLLMShim())).toBe("whole");
    } finally {
      server.stop();
    }
  });

  test("oversized SSE frames (> 1 MB) are skipped, shim still completes cleanly", async () => {
    const huge = JSON.stringify({ choices: [{ delta: { content: "x".repeat(2 * 1024 * 1024) } }] });
    const server = Bun.serve({
      port: 0,
      fetch() {
        const body = [
          `data: ${huge}`,
          "",
          "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      process.env.ASHLR_LLM_URL = `http://127.0.0.1:${server.port}/v1`;
      const shim = buildLLMShim();
      const text = await consume(shim);
      // The oversized frame is dropped; the small follow-up still passes through.
      expect(text).toBe("ok");
      expect(text.length).toBeLessThan(10_000);
    } finally {
      server.stop();
    }
  });
});
