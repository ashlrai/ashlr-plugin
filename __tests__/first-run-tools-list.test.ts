/**
 * First-run smoke: a brand-new install has no ~/.ashlr, no ~/.claude
 * credentials, and no ASHLR_* env. The router must still boot over stdio,
 * answer initialize and tools/list, and serve ashlr__read and ashlr__grep on
 * a temp file — with nothing but the one-line startup banner on stderr.
 *
 * The spawn goes through scripts/ashlr-mcp.mjs — the same node trampoline the
 * published `ashlr-mcp` bin and the Claude plugin manifest use — so the test
 * covers bootstrap → mcp-entrypoint → router, not just the router alone.
 *
 * The child env is an allowlist (PATH, HOME/USERPROFILE, and the handful of
 * variables Windows needs to create processes). Spreading process.env would
 * leak ASHLR_PIPE_ENABLE, ASHLR_LLM_URL, CLAUDE_SESSION_ID, ANTHROPIC_API_KEY
 * and friends from the developer shell, making "first run" depend on whoever
 * happens to run the test — exactly the user-state dependence this guards.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import pkg from "../package.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "..");
const SAMPLE = "alpha line one\nbeta line two\ngamma needle here\n";
// The router's one-line startup banner is the only sanctioned stderr output;
// anything else (install chatter, warnings, stack traces) is a regression.
const BANNER = /^\[ashlr-router\] starting · \d+ tools registered · version=\S+ · host=\S+$/;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "first-run-test", version: "1" },
  },
};

const WINDOWS_SPAWN_VARS = [
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMDRIVE",
];

function firstRunEnv(home: string, prependPath?: string): Record<string, string> {
  const delim = process.platform === "win32" ? ";" : ":";
  const env: Record<string, string> = {
    PATH: prependPath ? `${prependPath}${delim}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
    HOME: home,
    USERPROFILE: home,
  };
  for (const key of WINDOWS_SPAWN_VARS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

interface Frame {
  id?: number;
  result?: {
    protocolVersion?: string;
    capabilities?: { tools?: unknown };
    serverInfo?: { name?: string; version?: string };
    instructions?: string;
    tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
}

interface RouterRun {
  frames: Frame[];
  stderr: string;
  exitCode: number | null;
}

async function runRouter(opts: {
  cwd: string;
  env: Record<string, string>;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  timeoutMs?: number;
}): Promise<RouterRun> {
  const requests = [
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ...opts.calls.map((call, i) => ({
      jsonrpc: "2.0",
      id: 3 + i,
      method: "tools/call",
      params: { name: call.name, arguments: call.arguments },
    })),
  ];
  const proc = spawn({
    cmd: ["node", join(ROOT, "scripts", "ashlr-mcp.mjs")],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
  });
  proc.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.end();
  const watchdog = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, opts.timeoutMs ?? 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(watchdog);
  const frames = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Frame;
      } catch {
        throw new Error(`non-protocol stdout line from router: ${line.slice(0, 200)}`);
      }
    });
  return { frames, stderr, exitCode };
}

describe("first run", () => {
  test(
    "initialize + tools/list + ashlr__read/ashlr__grep work with a fresh HOME and no config",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "ashlr-first-run-home-"));
      const project = await mkdtemp(join(tmpdir(), "ashlr-first-run-project-"));
      await writeFile(join(project, "sample.txt"), SAMPLE);
      try {
        const { frames, stderr, exitCode } = await runRouter({
          cwd: project,
          env: firstRunEnv(home),
          calls: [
            // A relative path proves the router adopted the launch folder:
            // it resolves against the project, not the plugin install dir.
            { name: "ashlr__read", arguments: { path: "sample.txt" } },
            { name: "ashlr__grep", arguments: { pattern: "needle", cwd: project } },
          ],
        });

        expect(exitCode).toBe(0);

        const bannerLines = stderr.split("\n").filter((line) => line.trim());
        expect(bannerLines.length).toBeLessThanOrEqual(1);
        for (const line of bannerLines) expect(line).toMatch(BANNER);

        const init = frames.find((f) => f.id === 1);
        expect(init?.result?.protocolVersion).toBe("2024-11-05");
        expect(init?.result?.serverInfo).toEqual({
          name: "ashlr-router",
          // The allowlist env never forwards ASHLR_VERSION, so the router
          // always reports the package version on first run.
          version: pkg.version,
        });
        expect(init?.result?.capabilities?.tools).toBeDefined();
        expect(typeof init?.result?.instructions).toBe("string");

        const list = frames.find((f) => f.id === 2);
        const tools = list?.result?.tools ?? [];
        const names = tools.map((t) => t.name);
        expect(names).toContain("ashlr__read");
        expect(names).toContain("ashlr__grep");
        for (const tool of tools) {
          expect(typeof tool.name).toBe("string");
          expect(typeof tool.description).toBe("string");
          expect(tool.inputSchema).toBeDefined();
        }

        const read = frames.find((f) => f.id === 3);
        expect(read?.result?.isError).toBeFalsy();
        expect(read?.result?.content?.[0]?.text).toContain("gamma needle here");

        const grep = frames.find((f) => f.id === 4);
        expect(grep?.result?.isError).toBeFalsy();
        expect(grep?.result?.content?.[0]?.text).toContain("sample.txt:3:gamma needle here");
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {});
        await rm(project, { recursive: true, force: true }).catch(() => {});
      }
    },
    40_000,
  );

  test.skipIf(process.platform === "win32")(
    "ashlr__grep reports a broken ripgrep instead of claiming no matches",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "ashlr-first-run-home-"));
      const project = await mkdtemp(join(tmpdir(), "ashlr-first-run-project-"));
      const stubbin = await mkdtemp(join(tmpdir(), "ashlr-rg-stub-"));
      await writeFile(join(project, "sample.txt"), SAMPLE);
      const stub = join(stubbin, "rg");
      await writeFile(stub, "#!/bin/sh\necho 'rg: stubbed failure' >&2\nexit 2\n");
      await chmod(stub, 0o755);
      try {
        const { frames, exitCode } = await runRouter({
          cwd: project,
          env: firstRunEnv(home, stubbin),
          calls: [{ name: "ashlr__grep", arguments: { pattern: "needle", cwd: project } }],
        });
        expect(exitCode).toBe(0);
        const grep = frames.find((f) => f.id === 3);
        const text = grep?.result?.content?.[0]?.text ?? "";
        expect(text).toContain("ripgrep exited 2");
        expect(text).toContain("stubbed failure");
        expect(text).not.toContain("no matches");
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {});
        await rm(project, { recursive: true, force: true }).catch(() => {});
        await rm(stubbin, { recursive: true, force: true }).catch(() => {});
      }
    },
    40_000,
  );
});
