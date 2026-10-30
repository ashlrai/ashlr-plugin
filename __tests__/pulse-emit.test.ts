/**
 * pulse-emit.test.ts — covers the Pulse OTel emitter hook.
 *
 * Runs the hook as a subprocess with ASHLR_PULSE_OTLP_ENDPOINT pointed at a
 * tiny local HTTP server so we can inspect the exact OTLP payload that
 * leaves the machine. Also covers the opt-out path (unset endpoint ⇒
 * zero network).
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "http";
import { AddressInfo } from "net";
import { resolve, join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// Each test spawns a cold `bun` process. On a loaded shared runner (macOS in
// particular) that has exceeded the 15s file default once, so give this file
// more headroom; the hook itself exits in milliseconds.
setDefaultTimeout(30_000);

const HOOK = resolve(import.meta.dir, "..", "hooks", "pulse-emit.ts");

interface Captured { path: string; user: string; authorization: string; body: string }

function startCaptureServer(responseDelayMs = 0): Promise<{ server: Server; url: () => string; next: () => Promise<Captured> }> {
  return new Promise((resolvePromise) => {
    const inbox: Captured[] = [];
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
        inbox.push(cap);
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }));
        };
        if (responseDelayMs) setTimeout(respond, responseDelayMs);
        else respond();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        server,
        url: () => `http://127.0.0.1:${port}/api/otlp/v1/traces`,
        // runHook waits for fetch to receive this server's response before it
        // exits, so a missing request is an immediate harness failure rather
        // than an unbounded waiter that can strand the test until timeout.
        next: async () => {
          const captured = inbox.shift();
          if (!captured) throw new Error("expected an OTLP request, but the capture inbox was empty");
          return captured;
        },
      });
    });
  });
}

// Use Bun's subprocess API instead of Node child_process event notifications,
// which have been lost in parallel macOS workers. Bound both exit and stderr
// collection so a stalled child or pipe cannot hang the test.
const KILL_AFTER_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 8_000;

async function runHook(
  env: Record<string, string>,
  stdin: string,
  opts: { script?: string; killAfterMs?: number } = {},
): Promise<{ code: number | null; stderr: string }> {
  const killAfterMs = opts.killAfterMs ?? KILL_AFTER_MS;
  const child = Bun.spawn([process.execPath, "run", opts.script ?? HOOK], {
    env: { PATH: process.env.PATH ?? "", ASHLR_PULSE_TIMEOUT_MS: String(DELIVERY_TIMEOUT_MS), ...env },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  // An opt-out hook can exit before reading stdin; Bun's pipe handles EPIPE.
  child.stdin.write(stdin);
  child.stdin.end();
  const completed = Promise.all([child.exited, new Response(child.stderr).text()])
    .then(([code, stderr]) => ({ code, stderr }));
  let guard: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ code: null; stderr: string }>((resolvePromise) => {
    guard = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The child may have already exited while stderr was draining. */ }
      resolvePromise({ code: null, stderr: `[test] hook did not exit within ${killAfterMs}ms, killed\n` });
    }, killAfterMs);
  });
  try {
    return await Promise.race([completed, timeout]);
  } finally {
    clearTimeout(guard!);
  }
}

type Capture = Awaited<ReturnType<typeof startCaptureServer>>;

// Each test owns its capture server, so parallel tests can never read
// another test's server or inbox (issue #138).
async function withServer(fn: (cap: Capture) => Promise<void>, responseDelayMs = 0): Promise<void> {
  const cap = await startCaptureServer(responseDelayMs);
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
  it("is a silent no-op when ASHLR_PULSE_OTLP_ENDPOINT is unset", async () => {
    const r = await runHook({}, JSON.stringify({ tool_name: "Read", tool_input: { path: "/x" } }));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

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

  it("keeps concurrent capture servers and their inboxes independent", async () => {
    await Promise.all(["alice", "bob"].map((user) => withServer(async (cap) => {
      const r = await runHook(
        { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), ASHLR_PULSE_USER: user },
        JSON.stringify({ tool_name: "Read", tool_input: {} }),
      );
      expect(r.code).toBe(0);
      const got = await cap.next();
      expect(got.user).toBe(user);
      expect(JSON.parse(got.body).resourceSpans[0].scopeSpans[0].spans[0].name).toBe("tool.Read");
    })));
  });

  it("captures a span when the server responds after the default hook timeout", () => withServer(async (cap) => {
    const r = await runHook(
      { ASHLR_PULSE_OTLP_ENDPOINT: cap.url(), ASHLR_PULSE_USER: "slow-server" },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const got = await cap.next();
    expect(got.user).toBe("slow-server");
    expect(JSON.parse(got.body).resourceSpans[0].scopeSpans[0].spans[0].name).toBe("tool.Read");
  }, 1_800));

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

  it("test harness preserves a child's exit code and stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-emit-exit-"));
    try {
      const script = join(dir, "exit.ts");
      writeFileSync(script, 'process.stderr.write("child diagnostic\\n"); process.exit(7);\n');
      const r = await runHook({}, "", { script });
      expect(r.code).toBe(7);
      expect(r.stderr).toBe("child diagnostic\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
