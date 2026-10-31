import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("standalone server stays alive with open stdin and exits on EOF despite background work", async () => {
  const home = await mkdtemp(join(tmpdir(), "ashlr-stdin-eof-"));
  // Model a handler's persistent background resource without changing the real
  // server entry point. Without EOF handling this timer keeps it alive forever.
  const preload = join(home, "keep-alive.ts");
  await writeFile(preload, "setInterval(() => {}, 60_000);\n");
  const proc = Bun.spawn({
    cmd: [process.execPath, "--preload", preload, resolve(import.meta.dir, "../servers/diff-server.ts")],
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  try {
    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "stdin-eof-test", version: "1" },
      },
    }) + "\n");
    // Wait for a real MCP response so an import/startup failure cannot pass.
    let output = "";
    const decoder = new TextDecoder();
    await within((async () => {
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Server exited before initialization");
        output += decoder.decode(chunk.value, { stream: true });
      }
    })(), 15_000);
    const response = JSON.parse(output.split("\n")[0]);
    expect(response.id).toBe(1);
    expect(response.result.serverInfo.name).toBe("ashlr-diff");

    const state = await Promise.race([
      proc.exited.then(() => "exited"),
      Bun.sleep(2_000).then(() => "alive"),
    ]);
    expect(state).toBe("alive");
    const closedAt = performance.now();
    await proc.stdin.end();
    expect(await within(proc.exited, 5_000)).toBe(0);
    expect(performance.now() - closedAt).toBeLessThan(5_000);
  } finally {
    proc.kill();
    await proc.exited;
    reader.releaseLock();
    await rm(home, { recursive: true, force: true });
  }
}, 25_000);
