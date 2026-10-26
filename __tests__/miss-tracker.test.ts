import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { MISS_WINDOW_TURNS, missStatsPath, observeToolCall, readMissStats } from "../servers/_miss-tracker";

const S = "miss-session";
const CWD = "/repo";
const AR = "mcp__plugin_ashlr_ashlr__ashlr__read";
const AG = "mcp__plugin_ashlr_ashlr__ashlr__grep";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-miss-"));
  delete process.env.ASHLR_TUNING;
  delete process.env.ASHLR_SESSION_LOG;
});
afterEach(() => {
  delete process.env.ASHLR_TUNING;
  rmSync(home, { recursive: true, force: true });
});

const obs = (tool: string, input: unknown, turn: number) => observeToolCall(tool, input, turn, S, home, CWD);

describe("miss tracker", () => {
  test("hit: compressed result not followed by a native read is not a miss", () => {
    expect(obs(AR, { path: "src/a.ts" }, 0)).toBe("compressed");
    expect(obs("Read", { file_path: "/repo/src/other.ts" }, 1)).toBeNull();
    expect(readMissStats(home, CWD)).toEqual({ ashlr__read: { ".ts": { compressed: 1, misses: 0 } } });
  });

  test("miss: native Read of the same target within the window", () => {
    obs(AR, { path: "src/a.ts" }, 0);
    expect(obs("Read", { file_path: "/repo/src/a.ts" }, 2)).toBe("miss");
    expect(obs("Read", { file_path: "/repo/src/a.ts" }, 3)).toBeNull(); // counted once
    expect(readMissStats(home, CWD).ashlr__read[".ts"]).toEqual({ compressed: 1, misses: 1 });
  });

  test("miss: native Grep after ashlr__grep on the same path", () => {
    obs(AG, { pattern: "foo", path: "src" }, 0);
    expect(obs("Grep", { pattern: "foo", path: "/repo/src" }, 1)).toBe("miss");
    expect(readMissStats(home, CWD).ashlr__grep["(none)"]).toEqual({ compressed: 1, misses: 1 });
  });

  test("outside window: native re-read after N turns is not a miss", () => {
    obs(AR, { path: "src/a.ts" }, 0);
    expect(obs("Read", { file_path: "/repo/src/a.ts" }, MISS_WINDOW_TURNS + 1)).toBeNull();
    expect(readMissStats(home, CWD).ashlr__read[".ts"].misses).toBe(0);
  });

  test("different target is not a miss", () => {
    obs(AR, { path: "src/a.ts" }, 0);
    expect(obs("Read", { file_path: "/repo/src/b.ts" }, 1)).toBeNull();
  });

  test("no content or paths stored", () => {
    obs(AR, { path: "src/secret-name.ts" }, 0);
    obs("Read", { file_path: "/repo/src/secret-name.ts" }, 1);
    const dir = join(home, ".ashlr", "miss-pending");
    const files = [missStatsPath(home, CWD), ...readdirSync(dir).map((f) => join(dir, f))];
    for (const f of files) expect(readFileSync(f, "utf-8")).not.toContain("secret-name");
  });

  test("ASHLR_TUNING=off disables tracking", () => {
    process.env.ASHLR_TUNING = "off";
    expect(obs(AR, { path: "src/a.ts" }, 0)).toBeNull();
    expect(readMissStats(home, CWD)).toEqual({});
  });
});
