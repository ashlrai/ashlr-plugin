import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("status example describes supported fields and matches telemetry output", () => {
  const command = readFileSync(join(root, "commands/ashlr-status.md"), "utf8");
  const example = command.match(/Example output for `\/ashlr-status` \(versions, state, and counts are illustrative[^\n]*\n\n```\n([\s\S]*?)\n```/);
  expect(example).not.toBeNull();
  const [main, telemetry] = example![1].split("\n\n");
  expect(main.split("\n")).toEqual([
    expect.stringMatching(/^ashlr-plugin v\d+\.\d+\.\d+$/),
    "  server:  ✓ reachable",
    "  genome:  ✓ (.ashlrcode/genome found)",
    expect.stringMatching(/^  core:    @ashlr\/core-efficiency@\d+\.\d+\.\d+$/),
    expect.stringMatching(/^  session: \d+ calls, ~[\d,]+ tokens saved$/),
  ]);

  const fixture = mkdtempSync(join(tmpdir(), "ashlr-status-example-"));
  try {
    const home = join(fixture, "home");
    const project = join(fixture, "project");
    mkdirSync(home);
    mkdirSync(join(project, ".ashlrcode", "genome"), { recursive: true });
    writeFileSync(join(project, ".ashlrcode", "genome", "example.md"), "# Example\n");
    const result = Bun.spawnSync([process.execPath, "run", join(root, "scripts/telemetry-status.ts")], {
      cwd: project,
      env: { HOME: home, ANTHROPIC_API_KEY: "fixture" },
    });
    expect(result.exitCode).toBe(0);
    expect(telemetry).toBe(result.stdout.toString().trimEnd());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
