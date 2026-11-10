import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { countFiles } from "../scripts/sync-tool-counts.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The expensive later stages of `check` are replaced by markers that only record
// reaching them, in order. The aggregate string, the tool-counts aliases and the
// count script itself stay byte-identical to the real package.
const INERT_STAGES: Record<string, string> = {
  "smoke:tools": "smoke:tools",
  typecheck: "typecheck",
  "mdx-lint": "mdx-lint",
  test: "test",
};
const SUB_CHECKS = ["server", "site", "vscode"] as const;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tool-counts-gate-"));
  temporary.push(dir);
  for (const file of [...countFiles, "servers/_tool-catalog.json", "scripts/sync-tool-counts.ts"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const [name, marker] of Object.entries(INERT_STAGES)) pkg.scripts[name] = `echo ${marker} >> .check-order.log`;
  for (const sub of SUB_CHECKS) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, "package.json"), JSON.stringify({
      name: `fixture-${sub}`, private: true,
      scripts: { check: `echo sub:${sub} >> ../.check-order.log` },
    }));
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function runCheck(dir: string) {
  // `:` is a drive-letter character on Windows, not a PATH separator.
  // `bun run check` also keeps the script's console.log off the captured
  // stdout there and still continues after a failing count check. Run the
  // same aggregate string through cmd so the exit code and the output are
  // the script's, which is what `bun run check` is defined to invoke.
  const pathValue = [dirname(process.execPath), process.env.Path, process.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter);
  const env = { ...process.env, PATH: pathValue, Path: pathValue };
  const script = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.check as string;
  const cmd = process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", script]
    : [process.execPath, "run", "check"];
  return Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe", env });
}

function orderLog(dir: string): string[] {
  const path = join(dir, ".check-order.log");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

describe("package check aggregate gates on tool-counts:check", () => {
  test("count drift fails the first stage and later commands never execute", () => {
    const dir = fixture();
    const readme = join(dir, "README.md");
    writeFileSync(readme, readFileSync(readme, "utf8").replace("54 MCP tools", "47 MCP tools"));

    const real = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const fixturePkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(fixturePkg.scripts.check).toBe(real.scripts.check);
    expect(fixturePkg.scripts["tool-counts:check"]).toBe(real.scripts["tool-counts:check"]);
    expect(fixturePkg.scripts["tool-counts:sync"]).toBe(real.scripts["tool-counts:sync"]);
    expect(real.scripts.check.startsWith("bun run tool-counts:check && ")).toBe(true);

    const run = runCheck(dir);
    const stdout = Buffer.from(run.stdout ?? []).toString();
    const stderr = Buffer.from(run.stderr ?? []).toString();
    if (run.exitCode !== 1 || !`${stdout}\n${stderr}`.includes("out of sync")) {
      throw new Error(`exit=${run.exitCode}\nstdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}\norder=${JSON.stringify(orderLog(dir))}`);
    }
    expect(orderLog(dir)).toEqual([]);
  }, 30_000);

  test("clean counts reach the unchanged later command sequence in order", () => {
    const dir = fixture();

    const run = runCheck(dir);
    const stdout = Buffer.from(run.stdout ?? []).toString();
    const stderr = Buffer.from(run.stderr ?? []).toString();
    const combined = `${stdout}\n${stderr}`;
    if (run.exitCode !== 0 || !combined.includes("Default MCP tools: 54; 0 file(s) out of sync")) {
      throw new Error(`exit=${run.exitCode}\nstdout=${JSON.stringify(stdout)}\nstderr=${JSON.stringify(stderr)}\norder=${JSON.stringify(orderLog(dir))}`);
    }
    expect(orderLog(dir)).toEqual([
      "smoke:tools", "typecheck", "mdx-lint", "test",
      "sub:server", "sub:site", "sub:vscode",
    ]);
  }, 30_000);
});
