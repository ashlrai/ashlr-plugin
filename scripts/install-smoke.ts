/**
 * Documented install, then the documented first command.
 * commit: pack this checkout and install that tarball.
 * release: install the version `npm view ashlr-plugin version` prints.
 *
 * Usage: bun scripts/install-smoke.ts commit|release
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
if (mode !== "commit" && mode !== "release") {
  console.error("usage: bun scripts/install-smoke.ts commit|release");
  process.exit(1);
}

const prefix = mkdtempSync(join(tmpdir(), "ashlr-install-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pathKey = process.platform === "win32" ? "Path" : "PATH";

function run(args: string[]): void {
  const child = spawnSync(npm, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

if (mode === "commit") {
  const packDir = mkdtempSync(join(tmpdir(), "ashlr-pack-"));
  run(["pack", "--pack-destination", packDir]);
  const tarball = readdirSync(packDir).find(name => name.endsWith(".tgz"));
  if (!tarball) {
    console.error("npm pack produced no tarball");
    process.exit(1);
  }
  run(["install", "-g", "--prefix", prefix, join(packDir, tarball)]);
} else {
  const view = spawnSync(npm, ["view", "ashlr-plugin", "version"], { encoding: "utf8" });
  const version = (view.stdout ?? "").trim();
  if (view.status !== 0 || !version) {
    console.error(view.stderr ?? "");
    console.error("npm view ashlr-plugin version failed");
    process.exit(view.status || 1);
  }
  console.log(`published release ashlr-plugin@${version}`);
  run(["install", "-g", "--prefix", prefix, `ashlr-plugin@${version}`]);
}

const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
const currentPath = process.env[pathKey] ?? process.env.PATH ?? process.env.Path ?? "";
const binName = process.platform === "win32" ? "ashlr-plugin.cmd" : "ashlr-plugin";
const child = spawnSync(binName, ["tools", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    [pathKey]: `${bin}${process.platform === "win32" ? ";" : ":"}${currentPath}`,
    ASHLR_DISABLE_CLOUD_LLM: "1",
  },
});
if (child.error) throw child.error;
const stdout = child.stdout ?? "";
if (child.status !== 0) {
  console.error(stdout);
  console.error(child.stderr ?? "");
  process.exit(child.status ?? 1);
}
let parsed: { schema?: string; count?: unknown };
try {
  parsed = JSON.parse(stdout);
} catch {
  console.error(stdout);
  console.error("ashlr-plugin tools --json did not print JSON");
  process.exit(1);
}
if (parsed.schema !== "ashlr-plugin.tools.v1" || typeof parsed.count !== "number") {
  console.error(stdout);
  console.error("ashlr-plugin tools --json did not match the documented schema");
  process.exit(1);
}
console.log(`install smoke ${mode}: exit 0, tools=${parsed.count}`);
