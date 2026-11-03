import { expect, test } from "bun:test";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };
import { listTools } from "../servers/_tool-base";

test("always-on tools have nonempty descriptions of at most 200 characters", () => {
  const alwaysOn = catalog.filter((tool) => !("enableEnv" in tool) || !tool.enableEnv);
  expect(alwaysOn.length).toBeGreaterThan(0);

  const invalid = alwaysOn.flatMap((tool) => {
    const description: unknown = tool.description;
    if (typeof description !== "string" || !description.trim()) {
      return [`${tool.name}: empty or missing description`];
    }
    return description.length > 200 ? [`${tool.name}: ${description.length} characters`] : [];
  });
  expect(invalid).toEqual([]);
});

test("live always-on descriptions match the bounded handshake catalog", async () => {
  await import("../servers/_router-handlers");
  const live = new Map(listTools().map((tool) => [tool.name, tool.description]));
  for (const tool of catalog.filter((tool) => !("enableEnv" in tool) || !tool.enableEnv)) {
    expect(live.get(tool.name), tool.name).toBe(tool.description);
  }
});
