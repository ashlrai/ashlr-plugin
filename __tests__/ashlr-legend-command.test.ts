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

  test("README command table example matches the legend output", () => {
    const readme = readFileSync(join(root, "README.md"), "utf-8");
    const row = readme.split("\n").find((line) => line.startsWith("| Decode the status line |"));
    expect(row).toBeDefined();
    expect(row).toContain("[`/ashlr-legend`](docs/command-examples.md#ashlr-legend)");
    const section = readFileSync(join(root, "docs/command-examples.md"), "utf-8")
      .split("### `/ashlr-legend`\n")[1];
    const example = /```(?:text|json)\n([\s\S]*?)\n```/.exec(section)?.[1].trim();
    expect(example?.length ?? 0).toBeGreaterThan(0);

    const res = Bun.spawnSync([process.execPath, "run", join(root, "scripts/print-legend.ts")]);
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.toString().split("\n").map((line) => line.trim());
    for (const line of example!.split("\n").map((l) => l.trim())) {
      if (line.length > 0) expect(lines).toContain(line);
    }
  });
});
