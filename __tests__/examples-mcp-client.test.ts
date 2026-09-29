/**
 * Keeps examples/mcp-client/measure.ts honest: it must complete a real MCP
 * stdio session against scripts/ashlr-mcp.ts and report real savings.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measure } from "../examples/mcp-client/measure.ts";

const dir = mkdtempSync(join(tmpdir(), "ashlr-example-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("examples/mcp-client/measure.ts", () => {
  test("measures ashlr__read and ashlr__grep over a real stdio session", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}: request handled status=200 path=/api/items/${i}`);
    lines[1500] = "line 1500: ERROR needle-token-42 upstream timeout";
    writeFileSync(join(dir, "app.log"), `${lines.join("\n")}\n`);
    writeFileSync(join(dir, "small.txt"), "tiny file\n");

    const out = await measure({ cwd: dir, files: ["app.log", "small.txt"], grep: "needle-token-42" });

    expect(out.toolCount).toBeGreaterThan(10);
    const [big, small] = out.files;
    expect(big!.rawBytes).toBeGreaterThan(100_000);
    expect(big!.returnedBytes).toBeGreaterThan(0);
    expect(big!.returnedBytes).toBeLessThan(big!.rawBytes / 5);
    // Small files pass through essentially unchanged.
    expect(small!.returnedBytes).toBeGreaterThanOrEqual(small!.rawBytes - 1);
    expect(out.grep.returnedBytes).toBeGreaterThan(0);
  }, 60_000);
});
