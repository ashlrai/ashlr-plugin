import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
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

  test("a Windows ledger path uses backslashes under USERPROFILE, not APPDATA", () => {
    const env = {
      USERPROFILE: "C:\\Users\\dev",
      HOME: "/home/dev",
      APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
    };
    const home = userHome(env, "win32");
    const ledger = win32.join(home, ".ashlr", "stats.json");
    expect(ledger).toBe("C:\\Users\\dev\\.ashlr\\stats.json");
    expect(win32.normalize("C:/Users/dev/.ashlr/stats.json")).toBe(ledger);
    expect(ledger.includes("AppData")).toBe(false);
  });

  test("a POSIX ledger path stays on HOME", () => {
    const home = userHome({ HOME: "/home/dev", USERPROFILE: "C:\\Users\\dev" }, "linux");
    expect(posix.join(home, ".ashlr", "stats.json")).toBe("/home/dev/.ashlr/stats.json");
  });

  test("host hooks start with node and do not call a .sh file", () => {
    const root = join(import.meta.dir, "..");
    for (const rel of ["hooks/hooks.json", "hooks/codex-hooks.json", ".claude-plugin/plugin.json"]) {
      const commands = [...readFileSync(join(root, rel), "utf8").matchAll(/"command": "([^"]*)"/g)].map((match) => match[1]);
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command.startsWith("node")).toBe(true);
        expect(command.includes(".sh")).toBe(false);
      }
    }
  });

  test("a Windows hook path still names hook-bootstrap.mjs", () => {
    const root = "C:\\Users\\dev\\.claude\\plugins\\cache\\ashlr-marketplace\\ashlr\\1.38.7";
    const command = `node "${win32.join(root, "scripts", "hook-bootstrap.mjs")}" "${win32.join(root, "hooks", "pretooluse-read.ts")}"`;
    expect(command.startsWith("node ")).toBe(true);
    expect(command.includes(".sh")).toBe(false);
    expect(win32.basename(command.split('"')[1] ?? "")).toBe("hook-bootstrap.mjs");
  });

  test("bun lookup skips .cmd shims", () => {
    const src = readFileSync(join(import.meta.dir, "../scripts/bun-resolve.mjs"), "utf8");
    expect(src).toContain('"bun.exe"');
    expect(src).not.toContain('".cmd"');
    expect(src).toContain("PATHEXT");
  });
});
