import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = readFileSync(join(import.meta.dir, "../scripts/install-smoke.ts"), "utf8");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);

function releaseSmoke(platform: string, failure = "") {
  const home = mkdtempSync(join(tmpdir(), "install-smoke-test-"));
  try {
    const script = join(home, "install-smoke.mjs");
    writeFileSync(script, javascript);
    // Isolate module mocks and platform overrides from the rest of the suite.
    // The launcher models Windows' inability to execute a .cmd without a shell.
    return spawnSync(Bun.which("node")!, ["--input-type=module", "--eval", `
      import childProcess from "node:child_process";
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      import { strict as assert } from "node:assert";
      const platform = ${JSON.stringify(platform)};
      const failure = ${JSON.stringify(failure)};
      const calls = [];
      Object.defineProperty(process, "platform", { value: platform });
      os.tmpdir = () => ${JSON.stringify(home)};
      childProcess.spawnSync = (command, args, options) => {
        calls.push(args[0]);
        const ok = { status: 0, stdout: "", stderr: "" };
        if (command.endsWith(".cmd") && !options.shell) {
          return { ...ok, status: null, error: new Error(".cmd requires a shell") };
        }
        if (args[0] === "view") {
          assert.equal(command, platform === "win32" ? "npm.cmd" : "npm");
          assert.deepEqual(args, ["view", "ashlr-plugin", "version"]);
          assert.equal(Boolean(options.shell), platform === "win32");
          if (failure === "spawn") return { ...ok, status: null, error: new Error("npm launch failed") };
          if (failure === "view") return { ...ok, status: 7, stderr: "registry unavailable" };
          return { ...ok, stdout: failure === "empty" ? "" : "1.38.8\\r\\n" };
        }
        if (args[0] === "install") {
          assert.deepEqual(calls, ["view", "install"]);
          assert.equal(args.at(-1), "ashlr-plugin@1.38.8");
          return { ...ok, status: failure === "install" ? 9 : 0 };
        }
        assert.deepEqual(calls, ["view", "install", "tools"]);
        assert.deepEqual(args, ["tools", "--json"]);
        assert.equal(command, platform === "win32" ? "ashlr-plugin.cmd" : "ashlr-plugin");
        return { ...ok, stdout: JSON.stringify({
          ...(failure === "schema" ? {} : { schema: "ashlr-plugin.tools.v1" }), count: 54,
        }) };
      };
      syncBuiltinESMExports();
      process.argv[2] = "release";
      await import(${JSON.stringify(pathToFileURL(script).href)});
      assert.deepEqual(calls, ["view", "install", "tools"]);
    `], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 10_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test.each(["win32", "linux", "darwin"])("release smoke completes the install and CLI probe on %s", platform => {
  const result = releaseSmoke(platform);
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("install smoke release: exit 0, tools=54");
});

test.each([
  ["spawn", 1, "npm launch failed"],
  ["view", 7, "registry unavailable"],
  ["empty", 1, "npm view ashlr-plugin version failed"],
] as const)("release smoke stops before install on a %s failure", (failure, status, message) => {
  const result = releaseSmoke("win32", failure);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("published release");
});

test("release smoke propagates installation failure", () => {
  const result = releaseSmoke("win32", "install");
  expect(result.status).toBe(9);
  expect(result.stdout).not.toContain("install smoke release: exit 0");
});

test("release smoke still rejects a published CLI without the documented schema", () => {
  const result = releaseSmoke("win32", "schema");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("did not match the documented schema");
  expect(result.stdout).not.toContain("install smoke release: exit 0");
});
