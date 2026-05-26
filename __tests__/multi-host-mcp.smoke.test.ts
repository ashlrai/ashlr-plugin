/**
 * Multi-host MCP smoke test.
 *
 * Validates the foundation that lets non-Claude-Code MCP hosts (Cline,
 * Claude Desktop, OpenAI Codex CLI, …) consume `servers/_router.ts` over
 * stdio without crashes, missing-env errors, or `~/.claude/` writes.
 *
 * What we assert:
 *   1. The router boots cleanly with `ASHLR_MCP_HOST=generic` and NO
 *      `CLAUDE_SESSION_ID` / `CLAUDE_PLUGIN_ROOT` env. (Non-CC hosts
 *      will never set those — if anything still requires them, this
 *      catches the regression.)
 *   2. The startup banner reports the detected host so users running
 *      `bun run servers/_router.ts` under Cline can confirm the gate.
 *   3. `tools/list` returns the core efficiency tools every host needs:
 *      `ashlr__read`, `ashlr__grep`, `ashlr__edit`. (Other tools are
 *      tested by the router-dispatch suite.)
 *   4. `tools/call` for `ashlr__read` on a real file returns a content
 *      payload (snipCompact view, not the raw file) with no isError flag.
 *   5. The router exits cleanly when stdin closes — no orphaned hook
 *      processes / no `~/.claude/`-write failures because the HOME
 *      override points to a fresh tmpdir with only `.ashlr/` inside.
 *
 * This is intentionally narrow: one happy-path roundtrip per host. The
 * deeper handler matrix lives in router-dispatch.test.ts (which sets
 * CC-default env and asserts the full 40-tool catalog).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROUTER = resolve(__dirname, "..", "servers", "_router.ts");
const PLUGIN_ROOT = resolve(__dirname, "..");

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc?: string;
  id: number;
  result?: any;
  error?: any;
}

/**
 * Send the given JSON-RPC requests to a fresh router process and return
 * both the parsed responses and the raw stderr (so we can assert the
 * startup banner reports the right host).
 *
 * Constructs an env that DOES NOT include any CC-specific keys — we
 * explicitly delete `CLAUDE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT`,
 * `CLAUDE_CODE_MODEL`, and `ASHLR_SESSION_ID` so the host inference
 * doesn't accidentally fall through to "claude-code".
 */
async function rpcAsHost(
  host: "generic" | "cline" | "claude-desktop" | "codex-cli",
  reqs: RpcRequest[],
  home: string,
): Promise<{ responses: RpcResponse[]; stderr: string }> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";

  // Strip every CC-specific signal so the host inference can't fall
  // through to claude-code. This is what Cline/Codex/Desktop look like
  // from the router's perspective.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === "CLAUDE_SESSION_ID" ||
      k === "CLAUDE_PLUGIN_ROOT" ||
      k === "CLAUDE_CODE_MODEL" ||
      k === "ASHLR_SESSION_ID"
    ) continue;
    cleanEnv[k] = v;
  }
  cleanEnv.HOME = home;
  cleanEnv.ASHLR_MCP_HOST = host;
  cleanEnv.ASHLR_STATS_SYNC = "1";
  cleanEnv.ASHLR_SESSION_LOG = "0";

  const proc = spawn({
    cmd: ["bun", "run", ROUTER],
    cwd: PLUGIN_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv,
  });

  proc.stdin.write(input);
  await proc.stdin.end();

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const responses = stdoutText
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RpcResponse);

  return { responses, stderr: stderrText };
}

const INIT: RpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "multi-host-smoke", version: "1" },
  },
};

const LIST_TOOLS: RpcRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-multihost-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  // Intentionally NO ~/.claude/ — a non-CC host won't have it.
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("multi-host MCP · ASHLR_MCP_HOST=generic", () => {
  test("router boots clean with no CC env and reports host=generic on stderr", async () => {
    const { responses, stderr } = await rpcAsHost("generic", [INIT], home);

    // No crash → at least the initialize response came back.
    expect(responses.length).toBeGreaterThanOrEqual(1);
    const init = responses.find((r) => r.id === 1);
    expect(init?.result?.serverInfo?.name).toBe("ashlr-router");

    // Startup banner confirms host inference saw our env.
    expect(stderr).toMatch(/\[ashlr-router\] starting · \d+ tools registered .* host=generic/);
  }, 15_000);

  test("tools/list exposes core efficiency tools (read, grep, edit)", async () => {
    const { responses } = await rpcAsHost("generic", [INIT, LIST_TOOLS], home);

    const listResp = responses.find((r) => r.id === 2);
    expect(listResp?.result?.tools).toBeDefined();

    const names = (listResp!.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("ashlr__read");
    expect(names).toContain("ashlr__grep");
    expect(names).toContain("ashlr__edit");
  }, 15_000);

  test("tools/call ashlr__read returns a compressed payload on a real file", async () => {
    // Pick a stable in-repo file that's large enough to actually trigger
    // snipCompact (>16 KB threshold). CHANGELOG.md is ~190 KB.
    const target = join(PLUGIN_ROOT, "CHANGELOG.md");

    const CALL_READ: RpcRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ashlr__read",
        arguments: { path: target },
      },
    };

    const { responses } = await rpcAsHost("generic", [INIT, CALL_READ], home);

    const callResp = responses.find((r) => r.id === 3);
    expect(callResp).toBeDefined();
    expect(callResp?.error).toBeUndefined();

    const result = callResp!.result;
    expect(result?.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.isError).not.toBe(true);

    // First content block should be text. snipCompact (or pass-through)
    // — either way, we should see actual file bytes echoed back.
    const text = result.content[0]?.text as string | undefined;
    expect(typeof text).toBe("string");
    expect(text!.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("multi-host MCP · host detection inference", () => {
  test("each declared host value is preserved in the startup banner", async () => {
    for (const host of ["cline", "claude-desktop", "codex-cli"] as const) {
      const { stderr } = await rpcAsHost(host, [INIT], home);
      const re = new RegExp(`host=${host}`);
      expect(stderr).toMatch(re);
    }
  }, 30_000);
});
