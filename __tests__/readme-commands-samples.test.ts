import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const section = (name: string) => {
  const match = readme.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  expect(match).not.toBeNull();
  return match![1];
};

describe("README status line and command samples", () => {
  test("explains every status line field", () => {
    const status = section("Status-line");
    const table = status.split("| Field | Meaning |")[1]?.split("\n\n")[0] ?? "";
    const fields = ["`ashlr`", "Heartbeat and `7d` sparkline", "`ctx:", "`session ", "`≈$", "`lifetime ", "streak`", "machines`", "`brief:", "`last:", "`tip:"];
    for (const field of fields) {
      const row = table.split("\n").find((line) => line.includes(field));
      expect(row).toBeDefined();
      expect(row!.split("|")[2].trim().length).toBeGreaterThan(20);
    }
  });

  test("every command in the Commands table has a nonempty output sample", () => {
    const commands = section("Commands");
    const table = commands.split("| Task | Terminal | Claude Code |")[1]?.split("\n\n")[0] ?? "";
    const rows = table.split("\n").filter((line) => /^\|[^-]/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    const listed = new Set<string>();
    for (const row of rows) {
      const matches = [...row.matchAll(/`(ashlr-plugin [^`]+|\/ashlr-[\w-]+)`/g)];
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) listed.add(match[1]);
    }
    expect(listed.size).toBeGreaterThan(0);
    for (const command of listed) {
      const heading = `### \`${command}\`\n`;
      expect(commands).toContain(heading);
      const sample = commands.split(heading)[1]?.match(/^\s*```(?:text|json)\n([\s\S]*?)\n```/);
      expect(sample?.[1].trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
