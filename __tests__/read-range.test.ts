import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { ashlrRead } from "../servers/read-server";

describe("ashlr__read range", () => {
  test("returns exactly the requested numbered lines", async () => {
    const dir = mkdtempSync(join(process.cwd(), "rr-"));
    const f = join(dir, "a.txt");
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"));
    const out = await ashlrRead({ path: f, startLine: 10, endLine: 12 });
    expect(out).toContain("L10-L12 of 50");
    expect(out).toContain("10: line10");
    expect(out).toContain("12: line12");
    expect(out).not.toContain("line13");
    expect(out).not.toContain("line9\n");
  });
});
