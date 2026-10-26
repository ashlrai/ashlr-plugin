import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

describe("/ashlr-legend command", () => {
  test("command exists, is referenced by the tour, and its script prints a legend", () => {
    const cmd = readFileSync(join(root, "commands/ashlr-legend.md"), "utf-8");
    expect(cmd).toContain("name: ashlr-legend");
    const m = /scripts\/(print-legend\.ts)/.exec(cmd);
    expect(m).not.toBeNull();
    expect(existsSync(join(root, "scripts", m![1]!))).toBe(true);
    expect(readFileSync(join(root, "commands/ashlr-tour.md"), "utf-8")).toContain("/ashlr-legend");

    const res = Bun.spawnSync([process.execPath, "run", join(root, "scripts/print-legend.ts")]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim().length).toBeGreaterThan(0);
  });
});
