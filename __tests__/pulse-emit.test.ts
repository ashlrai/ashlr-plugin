/**
 * pulse-emit.test.ts — covers the Pulse OTel emitter hook.
 *
 * Runs the hook as a subprocess with ASHLR_PULSE_OTLP_ENDPOINT pointed at a
 * tiny local HTTP server so we can inspect the exact OTLP payload that
 * leaves the machine. Also covers the opt-out path (unset endpoint ⇒
 * zero network).
 *
 * Shared-state isolation (issue #138): every spawned child gets its own
 * capture server (ephemeral port) and its own temporary working directory,
 * so nothing a parallel worker's child derives from cwd — project hash,
 * fallback session id, git probes — can collide with this file's runs.
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { createHash } from "crypto";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { runHook, withServer } from "./_pulse-emit-harness";

// Each test spawns a cold `bun` process. On a loaded shared runner (macOS in
// particular) that has exceeded the 15s file default once, so give this file
// more headroom; the hook itself exits in milliseconds.
setDefaultTimeout(30_000);

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
    // The child ran in its own temp dir (issue #138), and the hash pins that.
    expect(attrs["claude.project.hash"]).toEqual({
      stringValue: createHash("sha256").update(r.cwd).digest("hex"),
    });
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

  it("completes an emission when no server is listening", async () => {
    const r = await runHook(
      {
        // Port 0 cannot be a listening TCP port; no shared port reservation is needed.
        ASHLR_PULSE_OTLP_ENDPOINT: "http://127.0.0.1:0/api/otlp/v1/traces",
        ASHLR_PULSE_TIMEOUT_MS: "500",
      },
      JSON.stringify({ tool_name: "Read", tool_input: {} }),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[ashlr-pulse-emit] OTLP POST failed:");
  });

  it("test harness preserves a child's exit code and stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-emit-exit-"));
    try {
      const script = join(dir, "exit.ts");
      writeFileSync(script, 'process.stderr.write("child diagnostic\\n"); process.exit(7);\n');
      const r = await runHook({}, "", { script, cwd: dir });
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
      const r = await runHook({}, "", { script, cwd: dir, killAfterMs: 500 });
      expect(r.code).toBeNull();
      expect(r.stderr).toContain("did not exit within 500ms, killed");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
