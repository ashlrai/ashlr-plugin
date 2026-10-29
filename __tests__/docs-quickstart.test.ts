import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("quickstart and status-line documentation", () => {
  test("Codex quickstart documents packaged install, verification, and MCP-only setup", () => {
    const quickstart = read("docs/codex-quickstart.md");

    expect(quickstart).toContain("codex plugin marketplace add ashlrai/ashlr-plugin");
    expect(quickstart).toContain("codex plugin add ashlr@ashlr-marketplace");
    expect(quickstart).toContain("codex-doctor --json");
    expect(quickstart).toContain("[mcp_servers.ashlr]");
    expect(quickstart).toContain("ashlr__savings");
  });

  test("README field table covers every status-line setting and output markers", () => {
    const readme = read("README.md");
    const implementation = read("scripts/savings-status-line.ts");
    const documentedFields = [
      "statusLine",
      "statusLineSession",
      "statusLineLifetime",
      "statusLineTips",
      "statusLineSparkline",
      "statusLineUpgradeNudge",
    ];

    for (const field of documentedFields) {
      expect(readme).toContain(`| \`${field}\` |`);
      expect(implementation).toContain(`${field}?: boolean`);
    }
    expect(readme).toContain("Example output | Meaning");
    expect(readme).toContain("ctx: 92%");
    expect(readme).toContain("(est.)");
  });

  test("legend page points to the complete field reference without inventing output", () => {
    const legend = read("site/content/docs/skills/legend.mdx");
    expect(legend).toContain("scripts/print-legend.ts");
    expect(legend).toContain("/docs/concepts/status-line");
    expect(legend).not.toContain("[40 tools]");
    expect(legend).not.toContain("genome: warm");
  });

});
