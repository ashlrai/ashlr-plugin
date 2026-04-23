/**
 * pulse-emit.test.ts — covers the Pulse OTel emitter hook.
 *
 * Runs the hook as a subprocess with ASHLR_PULSE_OTLP_ENDPOINT pointed at a
 * tiny local HTTP server so we can inspect the exact OTLP payload that
 * leaves the machine. Also covers the opt-out path (unset endpoint ⇒
 * zero network).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "http";
import { spawn } from "child_process";
import { AddressInfo } from "net";
import { resolve } from "path";

const HOOK = resolve(import.meta.dir, "..", "hooks", "pulse-emit.ts");

interface Captured { path: string; user: string; body: string }

function startCaptureServer(): Promise<{ server: Server; url: () => string; next: () => Promise<Captured> }> {
  return new Promise((resolvePromise) => {
    const inbox: Captured[] = [];
    const waiters: Array<(c: Captured) => void> = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        const cap: Captured = {
          path: req.url ?? "",
          user: (req.headers["x-ashlr-user"] as string) ?? "",
          body,
        };
        const w = waiters.shift();
        if (w) w(cap); else inbox.push(cap);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        server,
        url: () => `http://127.0.0.1:${port}/api/otlp/v1/traces`,
        next: () => new Promise<Captured>((ok) => {
          const ready = inbox.shift();
          if (ready) ok(ready); else waiters.push(ok);
        }),
      });
    });
  });
}

function runHook(env: Record<string, string>, stdin: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("bun", ["run", HOOK], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.stdin?.write(stdin);
    child.stdin?.end();
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });
}

let cap: Awaited<ReturnType<typeof startCaptureServer>>;

beforeEach(async () => { cap = await startCaptureServer(); });
afterEach(() => new Promise<void>((ok) => cap.server.close(() => ok())));

describe("hooks/pulse-emit.ts", () => {
  it("is a silent no-op when ASHLR_PULSE_OTLP_ENDPOINT is unset", async () => {
    const r = await runHook({}, JSON.stringify({ tool_name: "Read", tool_input: { path: "/x" } }));
    expect(r.code).toBe(0);
    // No request should have been made; assert the inbox is empty by setting
    // a very short timeout on .next().
    const race = await Promise.race([
      cap.next().then(() => "got-request"),
      new Promise((ok) => setTimeout(() => ok("no-request"), 200)),
    ]);
    expect(race).toBe("no-request");
  });

  it("emits one OTLP span per tool call, carrying GenAI + claude attributes", async () => {
    const r = await runHook(
      {
        ASHLR_PULSE_OTLP_ENDPOINT: cap.url(),
        ASHLR_PULSE_USER: "mason",
        CLAUDE_SESSION_ID: "sess-test-42",
      },
      JSON.stringify({
        tool_name: "ashlr__read",
        tool_input: { path: "src/server.ts" },
        tool_result: { content: [{ type: "text", text: "x".repeat(5000) }] },
      }),
    );
    expect(r.code).toBe(0);

    const got = await cap.next();
    expect(got.user).toBe("mason");
    expect(got.path).toBe("/api/otlp/v1/traces");

    const payload = JSON.parse(got.body) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }>;
      }>;
    };
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe("tool.ashlr__read");

    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    expect(attrs["gen_ai.system"]).toEqual({ stringValue: "anthropic" });
    expect(attrs["claude.session.id"]).toEqual({ stringValue: "sess-test-42" });
    expect(attrs["claude.tool.calls_count"]).toEqual({ intValue: "1" });
    expect(attrs["claude.tool.calls_types"]).toEqual({ stringValue: "ashlr__read" });
    expect(attrs["claude.project.hash"]).toBeDefined();
    expect(attrs["claude.tool.input_bytes"]).toBeDefined();
    expect(attrs["claude.tool.output_bytes"]).toBeDefined();
  });

  it("uses the process user id when ASHLR_PULSE_USER is unset", async () => {
    const r = await runHook(
      { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), USER: "alice" },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    const got = await cap.next();
    expect(got.user).toBe("alice");
  });

  it("falls back to 'unknown' tool name on malformed stdin", async () => {
    const r = await runHook(
      { ASHLR_PULSE_OTLP_ENDPOINT: cap.url() },
      "not-json",
    );
    expect(r.code).toBe(0);
    const got = await cap.next();
    const payload = JSON.parse(got.body) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe("tool.unknown");
  });

  it("never exits non-zero when the endpoint is unreachable", async () => {
    const r = await runHook(
      {
        // Unreachable port — connection refused within the 1500ms timeout.
        ASHLR_PULSE_OTLP_ENDPOINT: "http://127.0.0.1:1/api/otlp/v1/traces",
        ASHLR_PULSE_TIMEOUT_MS: "500",
      },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
  });
});
