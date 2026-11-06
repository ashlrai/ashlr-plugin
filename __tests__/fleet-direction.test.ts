import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetDirection } from "../scripts/fleet-direction.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fleet-direction-"));
  roots.push(root);
  for (const file of ["VISION.md", "MASON-INBOX.md"]) writeFileSync(join(root, file), `original ${file}\n`);
  return root;
}
const propose = (root: string, extra: string[] = []) => fleetDirection([
  "propose", "--root", root, "--author", "Mason", "--text", "Consider this\nnext step", ...extra,
], new Date("2026-10-30T12:00:00Z"));

test("reads current direction as JSON without creating proposals", () => {
  const root = fixture();
  expect(JSON.parse(JSON.stringify(fleetDirection(["read", "--root", root]))).direction).toBe("original VISION.md\n");
  expect(existsSync(join(root, "DIRECTION-PROPOSED.md"))).toBe(false);
  writeFileSync(join(root, "DIRECTION.md"), "Current priorities");
  expect(fleetDirection(["read", "--root", root, "--direction", "DIRECTION.md"]).direction).toBe("Current priorities");
});
test("creates then appends dated author-labelled suggestions preserving all prior bytes", () => {
  const root = fixture(), output = join(root, "DIRECTION-PROPOSED.md");
  expect(propose(root)).toMatchObject({ status: "proposed", author: "Mason", date: "2026-10-30T12:00:00.000Z" });
  const first = readFileSync(output, "utf8");
  expect(first).toContain('2026-10-30T12:00:00.000Z — "Mason"');
  expect(first).toContain("> Consider this\n> next step");
  writeFileSync(output, "Existing notes without a newline");
  propose(root);
  expect(readFileSync(output, "utf8")).toBe("Existing notes without a newline" + first);
  propose(root);
  expect(readFileSync(output, "utf8")).toBe("Existing notes without a newline" + first + first);
  for (const file of ["VISION.md", "MASON-INBOX.md"]) expect(readFileSync(join(root, file), "utf8")).toBe(`original ${file}\n`);
});
test("refuses protected filenames and arbitrary destinations", () => {
  const root = fixture();
  for (const file of ["VISION.md", "MASON-INBOX.md", "vision.md", "nested/../VISION.md", "other.md", "../DIRECTION-PROPOSED.md"]) {
    expect(() => propose(root, ["--output", file])).toThrow();
  }
});
test("refuses symlink and hardlink aliases to either protected file", () => {
  for (const file of ["VISION.md", "MASON-INBOX.md"]) {
    for (const link of [symlinkSync, linkSync]) {
      const root = fixture();
      link(join(root, file), join(root, "DIRECTION-PROPOSED.md"));
      expect(() => propose(root)).toThrow();
      expect(readFileSync(join(root, file), "utf8")).toBe(`original ${file}\n`);
    }
  }
});
test("invalid arguments and overlapping source fail before appending", () => {
  const root = fixture();
  for (const args of [[], ["oops"], ["propose"], ["read", "--unknown", "x"],
    ["propose", "--author", "bad\nauthor", "--text", "x"],
    ["propose", "--author", "A", "--text", " "], ["read", "--root"],
    ["read", "--root", root, "--root", root]]) expect(() => fleetDirection(args)).toThrow();
  expect(() => propose(root, ["--direction", "DIRECTION-PROPOSED.md"])).toThrow();
});
test("CLI emits parseable JSON and a nonzero JSON error on refusal", () => {
  const root = fixture(), script = join(import.meta.dir, "../scripts/fleet-direction.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args, "--root", root]);
  const read = run("read");
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout.toString()).direction).toBe("original VISION.md\n");
  expect(run("propose", "--author", "Mason", "--text", "Suggestion").exitCode).toBe(0);
  const refused = run("propose", "--author", "Mason", "--text", "Suggestion", "--output", "VISION.md");
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stderr.toString()).error).toContain("Only DIRECTION-PROPOSED.md");
});
