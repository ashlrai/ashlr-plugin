/**
 * The MCP launchers move the router to PLUGIN_ROOT; the router must still
 * work on the project its host launched it in. Also covers hook-bootstrap's
 * host detection under Claude Code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { adoptLaunchCwd } from "../servers/_cwd-clamp";

const ROOT = resolve(import.meta.dir, "..");

async function callRouter(
  cwd: string,
  env: Record<string, string>,
  calls: Array<[string, Record<string, unknown>]>,
): Promise<string[]> {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "launch-cwd-test", version: "1" } },
    },
    ...calls.map(([name, args], i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name, arguments: args },
    })),
  ];
  const proc = spawn({
    cmd: ["node", join(ROOT, "scripts", "bootstrap.mjs"), "servers/_router.ts"],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.flush();

  const texts = new Map<number, string>();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 20_000;
  while (texts.size < calls.length && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } };
        if (typeof msg.id === "number" && msg.id > 0) {
          texts.set(msg.id, msg.result?.content?.[0]?.text ?? JSON.stringify(msg));
        }
      } catch {
        // Not a protocol line.
      }
    }
  }
  proc.kill();
  await proc.exited;
  return calls.map((_, i) => texts.get(i + 1) ?? "<no response>");
}

describe("MCP router launch folder", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-launch-home-"));
    project = await realpath(await mkdtemp(join(tmpdir(), "ashlr-launch-project-")));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(join(project, "sample.txt"), "hello from the launch folder\n");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(project, { recursive: true, force: true }).catch(() => {});
  });

  test("relative paths and default folders mean the project the host launched in", async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: ROOT,
      ASHLR_TELEMETRY: "off",
      ASHLR_CONTEXT_DB_DISABLE: "1",
    };
    const [read, ls] = await callRouter(project, env, [
      ["ashlr__read", { path: "sample.txt" }],
      ["ashlr__ls", {}],
    ]);
    expect(read).toContain("hello from the launch folder");
    expect(ls).toContain("sample.txt");
    expect(ls).not.toContain("package.json");
  }, 30_000);
});

describe("adoptLaunchCwd", () => {
  const saved = { cwd: process.cwd(), launch: process.env.ASHLR_LAUNCH_CWD, root: process.env.CLAUDE_PLUGIN_ROOT };

  afterEach(() => {
    process.chdir(saved.cwd);
    for (const [key, value] of [
      ["ASHLR_LAUNCH_CWD", saved.launch],
      ["CLAUDE_PLUGIN_ROOT", saved.root],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("ignores an unset, missing, or plugin-install launch folder", async () => {
    delete process.env.ASHLR_LAUNCH_CWD;
    expect(adoptLaunchCwd()).toBeNull();

    process.env.ASHLR_LAUNCH_CWD = join(tmpdir(), "ashlr-launch-does-not-exist-" + process.pid);
    expect(adoptLaunchCwd()).toBeNull();

    process.env.CLAUDE_PLUGIN_ROOT = ROOT;
    process.env.ASHLR_LAUNCH_CWD = ROOT;
    expect(adoptLaunchCwd()).toBeNull();
    expect(process.cwd()).toBe(saved.cwd);
  });

  test("moves into an existing project folder", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ashlr-launch-adopt-")));
    try {
      process.env.ASHLR_LAUNCH_CWD = dir;
      expect(adoptLaunchCwd()).toBe(dir);
      expect(await realpath(process.cwd())).toBe(dir);
    } finally {
      process.chdir(saved.cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hook-bootstrap host detection", () => {
  test("Claude Code hooks are not treated as Codex hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-hook-host-"));
    // Hook stubs must live under the plugin's hooks/ dir (containment check).
    const hookDir = await mkdtemp(join(ROOT, "hooks", ".launch-cwd-"));
    const hook = join(hookDir, "print-env.ts");
    await writeFile(
      hook,
      "console.log(JSON.stringify({ host: process.env.ASHLR_MCP_HOST ?? null, mode: process.env.ASHLR_HOOK_MODE ?? null }));\n",
    );
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDECODE: "1" };
    const proc = spawn({ cmd: ["node", "scripts/hook-bootstrap.mjs", hook], cwd: ROOT, stdout: "pipe", stderr: "pipe", env });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    await rm(hookDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ host: null, mode: null });
  });
});
