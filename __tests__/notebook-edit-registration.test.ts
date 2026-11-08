import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTool } from "../servers/_tool-base";
import "../servers/notebook-edit-server-handlers";

describe("notebook edit registration", () => {
  test("rejects invalid arguments without changing the notebook", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".notebook-args-"));
    const path = join(dir, "test.ipynb");
    const original = JSON.stringify({ cells: [{ cell_type: "code", source: "old" }] });
    try {
      await writeFile(path, original);
      const tool = getTool("ashlr__notebook_edit")!;
      const schema = tool.inputSchema as { properties: { cellIndex: unknown } };
      expect(schema.properties.cellIndex).toMatchObject({ type: "integer", minimum: 0 });
      for (const invalid of [
        { cellIndex: 0.5 }, { cellIndex: -1 }, { cellIndex: "0" },
        { newSource: 42 }, { newSource: null }, { cellType: "raw" },
        { notebookPath: "" },
      ]) {
        const result = await tool.handler(
          { notebookPath: path, cellIndex: 0, newSource: "new", ...invalid },
          { env: process.env },
        );
        expect(result.isError).toBe(true);
        expect(await readFile(path, "utf8")).toBe(original);
      }
      const valid = await tool.handler(
        { notebookPath: path, cellIndex: 0, newSource: "new" },
        { env: process.env },
      );
      expect(valid.isError).not.toBe(true);
      expect(JSON.parse(await readFile(path, "utf8")).cells[0].source).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
