import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cleanups: string[] = [];
function temporary(parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, ".major-q13-"));
  cleanups.push(dir);
  return dir;
}
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("S8705 hook argument rejection", () => {
  test("refuses an option-shaped argument before invoking Bun", () => {
    const home = temporary(), hooks = temporary(join(root, "hooks"));
    const hook = join(hooks, "hook.ts"), marker = join(home, "executed");
    writeFileSync(hook, `await Bun.write(${JSON.stringify(marker)}, "ran");`);
    const result = spawnSync(Bun.which("node")!, [join(root, "scripts/hook-bootstrap.mjs"), hook, "--eval=1"], {
      encoding: "utf8", env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("refusing to run");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("S6505 legacy first-run install", () => {
  test.each([0, 7])("install status %i keeps lifecycle scripts disabled and handles launch", (status) => {
    const home = temporary(), scripts = join(home, "scripts"), bin = join(home, "bin");
    mkdirSync(scripts); mkdirSync(bin);
    copyFileSync(join(root, "scripts/mcp-entrypoint.sh"), join(scripts, "mcp-entrypoint.sh"));
    // A recording Bun prevents network/install effects while exercising the real shell entrypoint.
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "<%s>\\n" "$@" >> "$HOME/calls"\n' +
      `if [ "$1" = install ]; then exit ${status}; fi\n`, { mode: 0o755 });
    const run = () => spawnSync("/bin/bash", [join(scripts, "mcp-entrypoint.sh"), "servers/example.ts", "literal arg"], {
      encoding: "utf8", env: { HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    const first = run();
    expect(first.error).toBeUndefined();
    expect(first.status).toBe(status === 0 ? 0 : 1);
    const install = "<install>\n<--ignore-scripts>\n<--silent>\n", launch = "<run>\n<servers/example.ts>\n<literal arg>\n";
    expect(readFileSync(join(home, "calls"), "utf8")).toBe(install + (status === 0 ? launch : ""));
    expect(first.stdout).toBe("");
    expect(first.stderr).toContain(status === 0 ? "first-run" : "bun install failed");
    if (status === 0) {
      mkdirSync(join(home, "node_modules/@modelcontextprotocol/sdk"), { recursive: true });
      expect(run().status).toBe(0);
      expect(readFileSync(join(home, "calls"), "utf8")).toBe(install + launch + launch);
    }
  });
});

test("S5850 orient excludes generated paths but only excludes log files at the suffix", () => {
  const source = readFileSync(join(root, "servers/orient-server.ts"), "utf8");
  // Execute the actual candidate ranker with a deterministic rg result and no subprocesses.
  const body = source.slice(source.indexOf("function grepCandidates("), source.indexOf("\nfunction fallbackFileSearch("));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  const candidates = ["src/auth.ts", "node_modules/auth.ts", "dist/auth.ts", "build/auth.ts",
    "auth.lock.json", "auth.log", "auth.log.ts", "src/catalog.ts"];
  const rank = new Function("rgBinary", "spawnSync", "fallbackFileSearch", `${js}\nreturn grepCandidates;`)(
    () => "rg", () => ({ status: 0, stdout: candidates.join("\n") }), () => [],
  );
  expect(rank("/project", ["auth"], 20)).toEqual(["src/auth.ts", "auth.log.ts", "src/catalog.ts"]);
});

test("S9383 node selection starts steering and sessions without waiting", async () => {
  const source = readFileSync(join(root, "scripts/fleet-ui/node-map.js"), "utf8");
  const body = source.slice(source.lastIndexOf("\nif (typeof document"));
  const node = { id: "job:q13" }, events: string[] = [];
  const settled = Promise.withResolvers<void>();
  const launch = new Function("document", "window", "mountControlPanel", "mountSessionPanel", "mountSteerPanel", "mountNodeMap", body);
  const panel = (name: string) => () => ({ open() { events.push(name); return name === "sessions" ? settled.promise : Promise.resolve(); } });
  launch({}, { addEventListener() {} }, panel("controls"), panel("sessions"), panel("steering"),
    (_doc: unknown, options: { open(node: unknown): void }) => {
      expect(options.open(node)).toBeUndefined();
      return { stop() {} };
    });
  expect(events).toEqual(["controls", "steering", "sessions"]);
  settled.reject(new Error("session offline"));
  await settled.promise.catch(() => {});
});
