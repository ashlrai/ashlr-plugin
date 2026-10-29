import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("TODO example returns the documented fallback or matching lines", async () => {
  const doc = await readFile(new URL("../site/content/docs/tools/pipe.mdx", import.meta.url), "utf8");
  const section = doc.split("## Example — find all TODO comments in auth files")[1]?.split("## Limitations")[0];
  expect(section).toBeDefined();
  const expr = section!.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
  expect(expr).toBeDefined();
  expect(section).toContain("it returns `No TODOs found`");

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("glob", "read", "cwd", expr!);
  const readPaths: string[] = [];
  const read = async (path: string) => {
    readPaths.push(path);
    return path === "auth/match.ts" ? "first line\n// TODO: fix auth\nlast line" : "no tasks here";
  };

  expect(await run(async () => [], read, ".")).toBe("No TODOs found");
  expect(await run(async () => ["auth/clean.ts"], read, ".")).toBe("No TODOs found");
  expect(await run(async () => ["auth/clean.ts", "auth/match.ts"], read, "."))
    .toBe("auth/match.ts:\n// TODO: fix auth");

  readPaths.length = 0;
  expect(await run(async () => [...Array(20).fill("auth/clean.ts"), "auth/match.ts"], read, "."))
    .toBe("No TODOs found");
  expect(readPaths).toHaveLength(20);
});
