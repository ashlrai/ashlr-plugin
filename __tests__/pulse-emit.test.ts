/**
 * pulse-emit.test.ts — covers the Pulse OTel emitter hook.
 *
 * Runs the hook as a subprocess with ASHLR_PULSE_OTLP_ENDPOINT pointed at a
 * tiny local HTTP server so we can inspect the exact OTLP payload that
 * leaves the machine. Also covers the opt-out path (unset endpoint ⇒
 * zero network).
 */

import { beforeAll, describe, it, expect, setDefaultTimeout } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "http";
import { spawn } from "child_process";
import { AddressInfo } from "net";
import { resolve, join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { warmUpSpawn } from "./_spawn-warmup";

// Each test spawns a cold `bun` process. On a loaded shared runner (macOS in
// particular) that has exceeded the 15s file default once, so give this file
// more headroom; the hook itself exits in milliseconds.
setDefaultTimeout(30_000);

const HOOK = resolve(import.meta.dir, "..", "hooks", "pulse-emit.ts");

interface Captured { path: string; user: string; authorization: string; body: string }

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
          authorization: (req.headers["authorization"] as string) ?? "",
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

// Settles exactly once, on the first of: child "exit", child "close", or the
// kill guard. Waiting on "close" alone could hang past the test timeout on a
// loaded macOS runner (run 39222605762) because "close" also waits for every
// stdio stream, so a stalled pipe kept the promise open even after SIGKILL.
// The child is the running bun binary (process.execPath), so no PATH lookup,
// and stdout is ignored because no test reads it.
const KILL_AFTER_MS = 15_000;

function runHook(
  env: Record<string, string>,
  stdin: string,
  opts: { script?: string; killAfterMs?: number } = {},
): Promise<{ code: number | null; stderr: string }> {
  const killAfterMs = opts.killAfterMs ?? KILL_AFTER_MS;
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["run", opts.script ?? HOOK], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolvePromise({ code, stderr });
    };
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    // With ASHLR_PULSE_OTLP_ENDPOINT unset the hook exits before reading
    // stdin, so a slow parent can hit EPIPE writing to the closed pipe. The
    // hook's stdin handling is not what these tests assert, so ignore it.
    child.stdin?.on("error", () => {});
    child.on("error", (e) => { stderr += `[test] spawn failed: ${e.message}\n`; settle(null); });
    child.stdin?.write(stdin);
    child.stdin?.end();
    // Never wait on a child that fails to exit: kill it and settle with the
    // stall named in stderr so the exit code assertion explains the failure.
    const guard = setTimeout(() => {
      stderr += `[test] hook did not exit within ${killAfterMs}ms, killed\n`;
      child.kill("SIGKILL");
      settle(null);
    }, killAfterMs);
    // Give stderr a moment to drain after exit, then settle even if the
    // pipes never report closed.
    child.on("exit", (code) => { setTimeout(() => settle(code), 100); });
    child.on("close", (code) => settle(code));
  });
}

type Capture = Awaited<ReturnType<typeof startCaptureServer>>;

// Each test owns its capture server, so parallel tests can never read
// another test's server or inbox (issue #138).
async function withServer(fn: (cap: Capture) => Promise<void>): Promise<void> {
  const cap = await startCaptureServer();
  try {
    await fn(cap);
  } finally {
    await new Promise<void>((ok) => {
      cap.server.close(() => ok());
      // close() waits for open keep-alive connections; drop them so a lingering one cannot stall teardown.
      cap.server.closeAllConnections?.();
    });
  }
}

describe("hooks/pulse-emit.ts", () => {
  // The first spawn in this file has never reported exit on macOS CI while later ones did; see _spawn-warmup.ts.
  beforeAll(async () => { await warmUpSpawn(); });

  it("is a silent no-op when ASHLR_PULSE_OTLP_ENDPOINT is unset", () => withServer(async (cap) => {
    const r = await runHook({}, JSON.stringify({ tool_name: "Read", tool_input: { path: "/x" } }));
    expect(r.code).toBe(0);
    // No request should have been made; assert the inbox is empty by setting
    // a very short timeout on .next().
    const race = await Promise.race([
      cap.next().then(() => "got-request"),
      new Promise((ok) => setTimeout(() => ok("no-request"), 200)),
    ]);
    expect(race).toBe("no-request");
  }));

  it("emits one OTLP span per tool call, carrying GenAI + claude attributes", () => withServer(async (cap) => {
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
  }));

  it("uses the process user id when ASHLR_PULSE_USER is unset", () => withServer(async (cap) => {
    const r = await runHook(
      { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), USER: "alice" },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    const got = await cap.next();
    expect(got.user).toBe("alice");
  }));

  it("falls back to 'unknown' tool name on malformed stdin", () => withServer(async (cap) => {
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
  }));

  it("sends Bearer auth and drops x-ashlr-user when ASHLR_PULSE_PAT is set", () => withServer(async (cap) => {
    const r = await runHook(
      {
        ASHLR_PULSE_OTLP_ENDPOINT: cap.url(),
        ASHLR_PULSE_PAT: "pulse_pat_abcdef0123456789abcdef0123456789",
        ASHLR_PULSE_USER: "should-be-ignored",
      },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    const got = await cap.next();
    expect(got.authorization).toBe("Bearer pulse_pat_abcdef0123456789abcdef0123456789");
    // x-ashlr-user must NOT also be sent — server's auth path stays unambiguous.
    expect(got.user).toBe("");
  }));

  it("falls back to x-ashlr-user when ASHLR_PULSE_PAT is unset", () => withServer(async (cap) => {
    const r = await runHook(
      { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), ASHLR_PULSE_USER: "mason" },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    const got = await cap.next();
    expect(got.user).toBe("mason");
    expect(got.authorization).toBe("");
  }));

  it("never exits non-zero when the endpoint is unreachable", () => withServer(async () => {
    const r = await runHook(
      {
        // Unreachable port — connection refused within the 1500ms timeout.
        ASHLR_PULSE_OTLP_ENDPOINT: "http://127.0.0.1:1/api/otlp/v1/traces",
        ASHLR_PULSE_TIMEOUT_MS: "500",
      },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
  }));

  // Guards the harness itself: a child that never exits must settle the
  // promise via the kill guard instead of hanging until the test timeout.
  it("test harness settles when a child never exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-emit-hang-"));
    try {
      const script = join(dir, "hang.ts");
      writeFileSync(script, "setInterval(() => {}, 1000);\n");
      const started = Date.now();
      const r = await runHook({}, "", { script, killAfterMs: 500 });
      expect(r.code).toBeNull();
      expect(r.stderr).toContain("did not exit within 500ms, killed");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
