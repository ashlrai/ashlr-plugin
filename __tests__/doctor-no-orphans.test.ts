/**
 * Regression: doctor's MCP probe must not leave server processes (or their
 * descendants) running after it returns.
 *
 * Before the fix, probeServer used Bun.spawn(["bun", ...]) plus proc.kill().
 * When `bun` on PATH was a shell shim (pnpm or npm global installs) the real
 * bun ran as a grandchild, and when the total cap won the race the per-server
 * timer never got to fire at all. Both paths left bun spinning at full CPU.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, chmod } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeAll, probeServer, realBunBinary } from "../scripts/doctor.ts";
import { runWithTimeout } from "../servers/_run-with-timeout.ts";

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0 but is not running.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z" || state === "X") return false;
  } catch {
    // no /proc (macOS): signal 0 is the best we have
  }
  return true;
}

async function waitAllDead(pids: number[], ms = 4000): Promise<number[]> {
  const until = Date.now() + ms;
  let live = pids.filter(alive);
  while (live.length > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    live = live.filter(alive);
  }
  return live;
}

async function readPids(file: string, want: number, ms = 4000): Promise<number[]> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(file)) {
      const pids = (await readFile(file, "utf-8")).split(/\s+/).filter(Boolean).map(Number);
      if (pids.length >= want) return pids;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid file ${file} never got ${want} pids`);
}

/** A fake MCP server that never answers and spawns a grandchild that also hangs. */
async function writeHangServer(dir: string, pidFile: string): Promise<string> {
  const script = join(dir, "hang.ts");
  await writeFile(
    script,
    [
      `import { appendFileSync } from "fs";`,
      `const kid = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });`,
      `appendFileSync(${JSON.stringify(pidFile)}, process.pid + " " + kid.pid + " ");`,
      `await new Promise(() => {});`,
      ``,
    ].join("\n"),
  );
  return script;
}

describe.skipIf(!posix)("doctor probe leaves no descendants", () => {
  test("total cap path kills the probe and its grandchild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-doctor-orphan-"));
    const pidFile = join(dir, "pids");
    const script = await writeHangServer(dir, pidFile);
    const t0 = Date.now();
    const results = await probeAll([{ name: "hanger", script }], 1500, 30_000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(results[0]!.ok).toBe(false);
    const pids = await readPids(pidFile, 2);
    expect(await waitAllDead(pids)).toEqual([]);
  }, 15_000);

  test("per-server timeout path kills the probe and its grandchild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashlr-doctor-orphan-"));
    const pidFile = join(dir, "pids");
    const script = await writeHangServer(dir, pidFile);
    const r = await probeServer("hanger", script, 1500);
    expect(r.ok).toBe(false);
    const pids = await readPids(pidFile, 2);
    expect(await waitAllDead(pids)).toEqual([]);
  }, 15_000);

  test("abort kills a shell shim and the binary it runs as a grandchild", async () => {
    // Mirrors the pnpm global `bun` shim: /bin/sh runs the real binary as a
    // child (no exec) and waits, so killing only the shim pid orphans it.
    const dir = await mkdtemp(join(tmpdir(), "ashlr-doctor-shim-"));
    const pidFile = join(dir, "pids");
    const shim = join(dir, "bun-shim");
    await writeFile(
      shim,
      `#!/bin/sh\necho $$ >> ${JSON.stringify(pidFile)}\n${JSON.stringify(process.execPath)} -e 'require("fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + " "); setInterval(() => {}, 1000)'\nexit $?\n`,
    );
    await chmod(shim, 0o755);
    const ac = new AbortController();
    const run = runWithTimeout({ command: shim, args: [], timeoutMs: 30_000, signal: ac.signal });
    const pids = await readPids(pidFile, 2);
    ac.abort();
    const res = await run;
    expect(res.timedOut).toBe(true);
    expect(await waitAllDead(pids)).toEqual([]);
  }, 15_000);
});

describe("realBunBinary", () => {
  test("uses the running bun binary instead of a PATH lookup", () => {
    expect(realBunBinary("/opt/x/bun")).toBe("/opt/x/bun");
    expect(realBunBinary("C:\\bun\\bun.exe".replace(/\\/g, "/"))).toBe("C:/bun/bun.exe");
    expect(realBunBinary("/usr/bin/node")).toBe("bun");
  });
});
