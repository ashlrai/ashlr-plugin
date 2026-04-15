/**
 * End-to-end integration tests for ashlr__logs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function rpc(
  reqs: RpcRequest[],
  cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const proc = spawn({
    cmd: ["bun", "run", "servers/logs-server.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASHLR_TEST_CWD: cwd ?? "" },
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

const INIT: RpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

function callLogs(id: number, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ashlr__logs", arguments: args },
  };
}

describe("ashlr-logs · bootstrap", () => {
  test("initialize + tools/list", async () => {
    const [init, list] = await rpc([
      INIT,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    expect(init.result).toMatchObject({ serverInfo: { name: "ashlr-logs", version: "0.1.0" } });
    const tools = list.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["ashlr__logs"]);
  });
});

describe("ashlr-logs · behavior", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ashlr-logs-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("filters error/warn from a 1000-line synthetic log", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i < 20) lines.push(`2026-04-14T10:00:${String(i).padStart(2, "0")} [ERROR] boom ${i}`);
      else if (i < 30) lines.push(`2026-04-14T11:00:${String(i - 20).padStart(2, "0")} [WARN] slow ${i}`);
      else lines.push(`2026-04-14T12:00:00 [INFO] tick ${i}`);
    }
    const p = join(tmp, "app.log");
    await writeFile(p, lines.join("\n") + "\n");

    const [, call] = await rpc(
      [INIT, callLogs(2, { path: p, lines: 2000, level: "error" })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).toContain("20 errors");
    expect(text).toContain("10 warnings");
    // All body lines (excluding header) should be ERROR-tagged.
    const body = text.split("\n\n").slice(1).join("\n\n");
    for (const bl of body.split("\n")) {
      if (!bl.trim()) continue;
      if (bl.startsWith("[ashlr__logs")) continue;
      expect(bl).toContain("[ERROR]");
    }
  });

  test("dedupes 50 consecutive identical lines", async () => {
    const lines: string[] = ["2026-04-14T10:00:00 [INFO] start"];
    for (let i = 0; i < 50; i++) lines.push("2026-04-14T10:00:01 [ERROR] same message");
    lines.push("2026-04-14T10:00:02 [INFO] end");
    const p = join(tmp, "d.log");
    await writeFile(p, lines.join("\n") + "\n");

    const [, call] = await rpc([INIT, callLogs(2, { path: p, lines: 1000 })], tmp);
    const text: string = call.result.content[0].text;
    expect(text).toContain("(50\u00d7)");
    // The dedupe should have collapsed — count "same message" occurrences.
    const occurrences = (text.match(/same message/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("since filter drops lines before the timestamp", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`2026-04-14T10:00:0${i}Z [INFO] early ${i}`);
    for (let i = 0; i < 10; i++) lines.push(`2026-04-14T12:00:0${i}Z [INFO] late ${i}`);
    const p = join(tmp, "s.log");
    await writeFile(p, lines.join("\n") + "\n");

    const [, call] = await rpc(
      [INIT, callLogs(2, { path: p, lines: 100, since: "2026-04-14T11:00:00Z" })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).not.toContain("early");
    expect(text).toContain("late");
  });

  test("malformed lines don't crash filters", async () => {
    const lines = [
      "\x00\x01 garbage line no timestamp",
      "random characters {{{{ }}}}",
      "2026-04-14T10:00:00 [ERROR] real",
      "", // blank
      "no-level-here just text",
    ];
    const p = join(tmp, "m.log");
    await writeFile(p, lines.join("\n") + "\n");
    const [, call] = await rpc([INIT, callLogs(2, { path: p, lines: 100 })], tmp);
    const text: string = call.result.content[0].text;
    expect(call.result.isError).toBeFalsy();
    expect(text).toContain("real");
  });

  test("glob pattern matches multiple files", async () => {
    await mkdir(join(tmp, "logs"));
    await writeFile(join(tmp, "logs", "a.log"), "2026-04-14T10:00:00 [ERROR] one\n");
    await writeFile(join(tmp, "logs", "b.log"), "2026-04-14T10:00:00 [ERROR] two\n");
    const [, call] = await rpc(
      [INIT, callLogs(2, { path: "logs/*.log", lines: 100, cwd: tmp })],
      tmp,
    );
    const text: string = call.result.content[0].text;
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toMatch(/2 files/);
  });
});
