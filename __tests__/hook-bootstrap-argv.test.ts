import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const NODE = Bun.which("node")!;
let sandbox: string;
let plugin: string;
let hooks: string;
let record: string;
let hookBody: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hook-argv-")));
  plugin = join(sandbox, "plugin");
  hooks = join(plugin, "hooks");
  record = join(sandbox, "invoked.json");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(join(plugin, "scripts"));
  for (const file of ["hook-bootstrap.mjs", "bun-resolve.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", file), join(plugin, "scripts", file));
  }
  hookBody = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input: await Bun.stdin.text() }));
console.log("hook stdout"); console.error("hook stderr"); process.exit(2);
`;
  writeFileSync(join(hooks, "valid.ts"), hookBody);
  mkdirSync(join(sandbox, "plugin-other"));
  writeFileSync(join(sandbox, "plugin-other", "outside.ts"), hookBody);
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function run(path: string, cwd = plugin, args: string[] = [], group = false) {
  return spawnSync(NODE, [join(plugin, "scripts", "hook-bootstrap.mjs"), ...(group ? ["--group"] : []), path, ...args], {
    cwd,
    input: "payload",
    encoding: "utf8",
    env: { PATH: dirname(process.execPath), HOME: sandbox, USERPROFILE: sandbox },
  });
}

function expectRefusal(path: string, cwd = plugin, group = false) {
  const result = run(path, cwd, [], group);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(group ? "skipping invalid hook path" : "refusing to run");
  expect(existsSync(record)).toBe(false);
}

describe("hook-bootstrap hook path validation before spawn", () => {
  test.each(["absolute", "relative", "normalized"])("preserves valid %s hook behavior", (kind) => {
    const path = kind === "absolute" ? join(hooks, "valid.ts")
      : kind === "relative" ? "hooks/valid.ts" : "hooks/../hooks/valid.ts";
    const result = run(path, plugin, ["arg with spaces", "literal;$value"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("hook stdout\n");
    expect(result.stderr).toBe("hook stderr\n");
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ args: ["arg with spaces", "literal;$value"], input: "payload" });
  });

  test("rejects traversal to an existing outside-root script", () => {
    expectRefusal("../plugin-other/outside.ts");
  });

  test("rejects an absolute outside-root script with a shared root prefix", () => {
    expectRefusal(join(sandbox, "plugin-other", "outside.ts"));
  });

  test.each(["--eval.ts", "-e.ts"])("rejects existing leading-dash path %s", (path) => {
    writeFileSync(join(hooks, path), hookBody);
    expectRefusal(path, hooks);
  });

  test("preserves the stricter hooks directory boundary", () => {
    writeFileSync(join(plugin, "outside-hooks.ts"), hookBody);
    expectRefusal("outside-hooks.ts");
  });

  test("rejects a hook symlink escaping the plugin", () => {
    symlinkSync(join(sandbox, "plugin-other", "outside.ts"), join(hooks, "escape.ts"));
    expectRefusal("hooks/escape.ts");
  });

  test("rejects a hooks directory symlink escaping the plugin", () => {
    rmSync(hooks, { recursive: true });
    symlinkSync(join(sandbox, "plugin-other"), hooks, "junction");
    expectRefusal("hooks/outside.ts");
  });

  test("allows a hook symlink whose target remains in hooks", () => {
    symlinkSync(realpathSync(join(hooks, "valid.ts")), join(hooks, "alias.ts"));
    expect(run("hooks/alias.ts").status).toBe(2);
    expect(existsSync(record)).toBe(true);
  });

  test("group mode also rejects leading-dash hook paths", () => {
    writeFileSync(join(hooks, "--eval.ts"), hookBody);
    expectRefusal("--eval.ts", hooks, true);
  });
});
