import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const reference = readFileSync(join(root, "docs/commands.md"), "utf8").split("## Claude Code slash commands")[0]!;
const cli = readFileSync(join(root, "scripts/cli.ts"), "utf8");

test("terminal reference covers every dispatched command and alias", () => {
  const dispatch = cli.split("switch (subcommand)")[1]!;
  const names = [...dispatch.matchAll(/case "([^"]+)":/g)].map((match) => match[1]!);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(reference).toContain(name);
  expect(reference).toContain("--ashlr-handshake");
});

test("reference covers forwarded selftest and genome refresh options", () => {
  const selftestRow = reference.split("\n").find((line) => line.startsWith("| `ashlr-plugin selftest"))!;
  const genomeRow = reference.split("\n").find((line) => line.startsWith("| `ashlr-plugin genome-refresh"))!;
  for (const flag of ["--json", "--only", "--keep-tmp", "--timeout-ms"]) expect(selftestRow).toContain(flag);
  for (const flag of ["--json", "--full", "--dry-run", "--quiet", "--debounce"]) expect(genomeRow).toContain(flag);
});

test("terminal help lists the same forwarded options as the reference", () => {
  const usage = cli.split("function usage")[1]!.split("process.exit(exitCode)")[0]!;
  for (const flag of ["--full", "--dry-run", "--quiet", "--debounce", "--keep-tmp", "--timeout-ms"]) {
    expect(usage).toContain(flag);
  }
  expect(usage).not.toContain("lifecycle hooks");
});

test("terminal help names every dispatched subcommand", () => {
  // `recut-plan` shipped dispatched and documented but missing from `help`.
  const usage = cli.split("function usage")[1]!.split("process.exit(exitCode)")[0]!;
  const dispatch = cli.split("switch (subcommand)")[1]!;
  const names = [...dispatch.matchAll(/case "([^"]+)":/g)]
    .map((match) => match[1]!)
    .filter((name) => !name.startsWith("-") && name !== "help");
  expect(names).toContain("recut-plan");
  for (const name of names) expect(usage).toContain(name);
  expect(usage).toContain("ashlr-plugin recut-plan --base <ref> [--head <ref>]");
});
