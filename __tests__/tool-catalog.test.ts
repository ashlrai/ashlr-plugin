/**
 * servers/_tool-catalog.json: every entry has a nonempty description.
 * Absent, non-string, or whitespace-only descriptions fail.
 */

import { describe, expect, test } from "bun:test";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

function badDescriptions(tools: readonly { name?: unknown; description?: unknown }[]): string[] {
  return tools.flatMap((t, i) =>
    typeof t.description === "string" && t.description.trim() !== "" ? [] : [String(t.name ?? `#${i}`)],
  );
}

describe("servers/_tool-catalog.json descriptions", () => {
  test("every entry has a nonempty description", () => {
    expect(catalog.length).toBeGreaterThan(0);
    expect(badDescriptions(catalog)).toEqual([]);
  });

  test("checker catches absent, empty, whitespace-only and non-string descriptions", () => {
    expect(
      badDescriptions([
        { name: "ok", description: "fine" },
        { name: "absent" },
        { name: "empty", description: "" },
        { name: "blank", description: " \n\t " },
        { name: "num", description: 3 },
      ]),
    ).toEqual(["absent", "empty", "blank", "num"]);
  });
});
