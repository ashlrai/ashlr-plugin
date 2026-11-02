import { expect, test } from "bun:test";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

test("pipe catalog entry describes its experimental, default-off availability", () => {
  const entries = catalog.filter((tool) => tool.name === "ashlr__pipe");
  expect(entries).toHaveLength(1);

  const pipe = entries[0]!;
  expect(pipe.description).toMatch(/\bexperimental\b/i);
  expect(pipe.description).toMatch(/\boff by default\b/i);
  expect(pipe.enableEnv).toBe("ASHLR_PIPE_ENABLE");
  expect(pipe.description).toContain(`${pipe.enableEnv}=1`);
});
