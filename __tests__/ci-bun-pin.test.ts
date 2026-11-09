import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `bun-version: latest` makes setup-bun query GitHub for the newest release on
// every job. That lookup failed twice in a row on main run 42568245722 and
// failed the whole gate before any repo code ran. Keep the version pinned.
describe("ci.yml bun pin", () => {
  const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  const versions = [...yml.matchAll(/bun-version:\s*(\S+)/g)].map((m) => m[1]);

  test("every setup-bun step is present", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  test("no setup-bun step floats on latest", () => {
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
