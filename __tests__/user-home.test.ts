import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../scripts/lib/user-home.ts";

describe("user home", () => {
  test("Windows prefers USERPROFILE over HOME", () => {
    expect(userHome({ USERPROFILE: "C:\\Users\\dev", HOME: "/home/dev" }, "win32")).toBe("C:\\Users\\dev");
  });

  test("macOS and Linux prefer HOME over USERPROFILE", () => {
    const env = { HOME: "/home/dev", USERPROFILE: "C:\\Users\\dev" };
    expect(userHome(env, "linux")).toBe("/home/dev");
    expect(userHome(env, "darwin")).toBe("/home/dev");
  });

  test("a tilde is not a home directory", () => {
    expect(() => userHome({ HOME: "~" }, "linux")).toThrow(/home directory/);
  });

  test("bun lookup skips .cmd shims", () => {
    const src = readFileSync(join(import.meta.dir, "../scripts/bun-resolve.mjs"), "utf8");
    expect(src).toContain('"bun.exe"');
    expect(src).not.toContain('".cmd"');
    expect(src).toContain("PATHEXT");
  });
});
