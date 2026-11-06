import { expect, test } from "bun:test";
import { join } from "node:path";
import catalog from "../servers/_tool-catalog.json" with { type: "json" };

test("pipe catalog entry describes its experimental, default-off availability", () => {
  const entries = catalog.filter((tool) => tool.name === "ashlr__pipe");
  expect(entries).toHaveLength(1);

  const pipe = entries[0]!;
  expect(pipe.description).toMatch(/\bexperimental\b/i);
  expect(pipe.description).toMatch(/\boff by default\b/i);
  expect(pipe.description).toMatch(
    /^\[EXPERIMENTAL\] Executes model-authored JS code server-side — off by default, enable with ASHLR_PIPE_ENABLE=1\./,
  );
  expect(pipe.enableEnv).toBe("ASHLR_PIPE_ENABLE");
  expect(pipe.description).toContain(`${pipe.enableEnv}=1`);
});

test("the catalog's pipe flag enables registration only for the value 1", () => {
  const pipe = catalog.find((tool) => tool.name === "ashlr__pipe");
  expect(pipe?.enableEnv).toBe("ASHLR_PIPE_ENABLE");

  // Exercise the real lazy registration in a child so flag and registry changes
  // cannot affect other tests in this process.
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { registerLazyTools } = await import('./servers/_lazy-tools.ts');
    const { getTool, __resetRegistryForTests } = await import('./servers/_tool-base.ts');
    const results = [];
    for (const value of [undefined, '', '0', 'true', '1']) {
      __resetRegistryForTests();
      if (value === undefined) delete process.env.ASHLR_PIPE_ENABLE;
      else process.env.ASHLR_PIPE_ENABLE = value;
      process.env.ASHLR_PIPE_ALLOW_BASH = '1';
      registerLazyTools();
      results.push({ pipe: !!getTool('ashlr__pipe'), glob: !!getTool('ashlr__glob') });
    }
    process.stdout.write(JSON.stringify(results));
  `], { cwd: join(import.meta.dir, ".."), env: { HOME: process.env.HOME!, PATH: process.env.PATH! } });

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([
    { pipe: false, glob: true },
    { pipe: false, glob: true },
    { pipe: false, glob: true },
    { pipe: false, glob: true },
    { pipe: true, glob: true },
  ]);
});
