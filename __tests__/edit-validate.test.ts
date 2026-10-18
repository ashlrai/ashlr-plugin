import { describe, expect, test } from "bun:test";
import { validateEdit } from "../servers/_edit-validate.ts";

const SAFE = { introducedError: false, detail: "" };

describe("validateEdit: JSON", () => {
  test("valid to valid is safe", async () => {
    expect(await validateEdit("/p/a.json", '{"a":1}', '{"a":2}')).toEqual(SAFE);
  });
  test("an edit that breaks valid JSON is reported with a bounded detail", async () => {
    const r = await validateEdit("/p/a.json", '{"a":1}', '{"a":');
    expect(r.introducedError).toBe(true);
    expect(r.detail.startsWith("JSON parse error: ")).toBe(true);
    expect(r.detail.length).toBeLessThanOrEqual("JSON parse error: ".length + 120);
  });
  test("an original that was already broken is not blamed on the edit", async () => {
    expect(await validateEdit("/p/a.json", '{"a":', '{"a":,}')).toEqual(SAFE);
  });
  test("the extension check is case-insensitive", async () => {
    const r = await validateEdit("/p/A.JSON", "{}", "{");
    expect(r.introducedError).toBe(true);
  });
});

describe("validateEdit: skipped and safe cases", () => {
  test("unwired extensions are skipped even when the content is garbage", async () => {
    for (const f of ["/p/a.py", "/p/a.yaml", "/p/README.md", "/p/Makefile", "/p/noext"]) {
      expect(await validateEdit(f, "ok", "(((")).toEqual(SAFE);
    }
  });
  test("never throws on odd input", async () => {
    await expect(validateEdit("", "", "")).resolves.toBeDefined();
    await expect(validateEdit("/p/a.json", "", "")).resolves.toBeDefined();
  });
  test("a JS or TS file with an unchanged clean body is safe", async () => {
    const src = "export const a = 1;\n";
    expect(await validateEdit("/p/a.ts", src, src)).toEqual(SAFE);
    expect(await validateEdit("/p/a.js", src, src)).toEqual(SAFE);
  });
});
