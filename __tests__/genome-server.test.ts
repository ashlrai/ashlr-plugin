/**
 * Tests for servers/genome-server.ts
 *
 * Exercises the exported handler functions against a real genome tmpdir
 * (initialized via @ashlr/core-efficiency's initGenome), plus one end-to-end
 * stdio smoke test to verify MCP wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { initGenome, loadPendingProposals, loadMutations } from "@ashlr/core-efficiency/genome";
import {
  handleConsolidate,
  handlePropose,
  handleStatus,
  renderStatus,
} from "../servers/genome-server";

const SERVER = resolve(__dirname, "..", "servers", "genome-server.ts");

let project: string;

async function freshGenome(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-genome-srv-"));
  await initGenome(dir, {
    project: "test",
    vision: "test vision",
    milestone: "m1",
  });
  return dir;
}

beforeEach(async () => {
  project = await freshGenome();
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("handlePropose", () => {
  test("queues a proposal and returns its id", async () => {
    const out = await handlePropose({
      section: "knowledge/decisions.md",
      content: "Chose bun for speed.",
      operation: "append",
      rationale: "Runtime preference for test speed",
      cwd: project,
    });
    expect(out).toMatch(/^proposal prop-/);
    expect(out).toContain("knowledge/decisions.md");
    expect(out).toContain("append");
    const pending = await loadPendingProposals(project);
    expect(pending.length).toBe(1);
    expect(pending[0]!.agentId).toBe("ashlr:code");
  });

  test("rejects when no genome present", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ashlr-nogenome-"));
    try {
      const out = await handlePropose({
        section: "knowledge/decisions.md",
        content: "x",
        rationale: "y",
        cwd: empty,
      });
      expect(out).toContain("no genome found");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("rejects invalid operation", async () => {
    const out = await handlePropose({
      section: "knowledge/decisions.md",
      content: "x",
      rationale: "y",
      operation: "nuke" as never,
      cwd: project,
    });
    expect(out).toContain("invalid operation");
  });
});

describe("handleConsolidate — sequential apply (no LLM)", () => {
  test("two append proposals to same section are both applied", async () => {
    await handlePropose({
      section: "knowledge/decisions.md",
      content: "Decision A: use bun.",
      operation: "append",
      rationale: "Speed.",
      cwd: project,
    });
    await handlePropose({
      section: "knowledge/decisions.md",
      content: "Decision B: use biome.",
      operation: "append",
      rationale: "Lint.",
      cwd: project,
    });

    const res = await handleConsolidate({ cwd: project, model: "none" });
    expect(res).toContain("consolidated");
    expect(res).toContain("applied 2");

    // Section should now contain both pieces of content.
    const section = readFileSync(
      join(project, ".ashlrcode", "genome", "knowledge", "decisions.md"),
      "utf-8",
    );
    expect(section).toContain("Decision A: use bun.");
    expect(section).toContain("Decision B: use biome.");

    // Pending queue cleared.
    const pending = await loadPendingProposals(project);
    expect(pending.length).toBe(0);

    // Mutation log grew.
    const muts = await loadMutations(project);
    expect(muts.length).toBe(2);
  });

  test("no pending proposals → reports so", async () => {
    const res = await handleConsolidate({ cwd: project, model: "none" });
    expect(res).toContain("no pending proposals");
  });
});

describe("handleStatus", () => {
  test("reports accurate pending + mutation counts", async () => {
    await handlePropose({
      section: "knowledge/decisions.md",
      content: "X",
      rationale: "R1",
      cwd: project,
    });
    await handlePropose({
      section: "strategies/active.md",
      content: "Y",
      operation: "append",
      rationale: "R2",
      cwd: project,
    });
    const s1 = await handleStatus({ cwd: project });
    expect(s1).toContain("2 pending proposals");
    expect(s1).toContain("0 mutations this gen");
    expect(s1).toContain("knowledge/decisions.md");
    expect(s1).toContain("strategies/active.md");

    // After consolidation, pending → 0, mutations grow.
    await handleConsolidate({ cwd: project, model: "none" });
    const s2 = await handleStatus({ cwd: project });
    expect(s2).toContain("0 pending proposals");
    expect(s2).toContain("2 mutations this gen");
    expect(s2).toContain("recent mutations");
  });

  test("renderStatus formats empty state cleanly", () => {
    const out = renderStatus([], [], 1);
    expect(out).toContain("0 pending proposals");
    expect(out).toContain("0 mutations this gen");
    expect(out).not.toContain("pending:");
    expect(out).not.toContain("recent mutations:");
  });
});

// ---------------------------------------------------------------------------
// Stdio integration smoke test — verifies MCP wiring is intact.
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  cwd: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", SERVER],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

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

describe("ashlr-genome · stdio MCP", () => {
  test("tools/list exposes all three genome tools", async () => {
    const [, r] = await rpc(
      [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
      project,
    );
    const names: string[] = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("ashlr__genome_propose");
    expect(names).toContain("ashlr__genome_consolidate");
    expect(names).toContain("ashlr__genome_status");
  });

  test("propose over stdio queues a proposal", async () => {
    // Propose and status are handled concurrently by the MCP dispatcher, so
    // we test them as two separate server invocations to get deterministic
    // ordering.
    const [, proposeRes] = await rpc(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ashlr__genome_propose",
            arguments: {
              section: "knowledge/decisions.md",
              content: "End-to-end test decision.",
              rationale: "Verifying MCP wiring.",
              cwd: project,
            },
          },
        },
      ],
      project,
    );
    expect(proposeRes.result.content[0].text).toMatch(/^proposal prop-/);

    const [, statusRes] = await rpc(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ashlr__genome_status",
            arguments: { cwd: project },
          },
        },
      ],
      project,
    );
    const statusText: string = statusRes.result.content[0].text;
    expect(statusText).toContain("1 pending proposal");
    expect(statusText).toContain("knowledge/decisions.md");
  });
});
