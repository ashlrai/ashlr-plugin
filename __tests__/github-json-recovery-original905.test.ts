import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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

function bunDir(): string {
  const bin = (process as any).execPath as string;
  if (bin && bin.includes("/")) return bin.slice(0, bin.lastIndexOf("/"));
  return `${process.env.HOME}/.bun/bin`;
}

function pathWith(binDir: string): string {
  return `${binDir}:${bunDir()}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`;
}


/** Fake gh that serves bodies[0] on the first non-auth call, bodies[1] on the second, etc. */
async function installSequencedGh(dir: string, bodies: string[]): Promise<string> {
  const binDir = join(dir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  for (let i = 0; i < bodies.length; i++) await writeFile(join(dir, `payload-${i}.txt`), bodies[i]!);
  const counter = join(dir, "count");
  await writeFile(counter, "0");
  const script = `#!/bin/sh
case "$1" in
  auth) echo "Logged in"; exit 0 ;;
esac
n=$(cat "${counter}")
echo $((n + 1)) > "${counter}"
cat "${dir}/payload-$n.txt"
exit 0
`;
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script);
  await chmod(ghPath, 0o755);
  return binDir;
}


const describeIfNotWin = process.platform === "win32" ? describe.skip : describe;
describeIfNotWin("original 905 recovery", () => {
  test("malformed JSON followed by valid JSON: first call errors, second succeeds in the same server", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-seq-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-seq-"));
    try {
      const valid = {
        number: 5,
        title: "Recovers after bad payload",
        state: "OPEN",
        author: { login: "zed" },
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-13T00:00:00Z",
        body: "still works",
        labels: [],
        comments: [],
      };
      const binDir = await installSequencedGh(work, ["{this-is-not-valid-json", JSON.stringify(valid)]);
      const [, bad, good] = await rpc(
        [
          INIT,
          callTool(2, "ashlr__issue", { number: 5, repo: "acme/widgets" }),
          callTool(3, "ashlr__issue", { number: 5, repo: "acme/widgets" }),
        ],
        { home, path: pathWith(binDir) },
      );
      // First parse fails with a structured error...
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0].text).toMatch(/malformed .* JSON/i);
      // ...and the server survives to parse the next, valid payload.
      expect(good.result.isError).toBeFalsy();
      expect(good.result.content[0].text).toMatch(/Issue #5/);
      expect(good.result.content[0].text).toContain("Recovers after bad payload");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

});
