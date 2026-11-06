import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const hooksDir = join(import.meta.dir, "..", "hooks");
const hooksJson = JSON.parse(
  readFileSync(join(hooksDir, "hooks.json"), "utf-8"),
) as { modules?: string[]; hooks?: Record<string, unknown[]> };

describe("plugin hooks paths", () => {
  test("every module and every ${CLAUDE_PLUGIN_ROOT} path in commands exists", () => {
    const root = join(hooksDir, "..");
    const missing: string[] = [];

    // modules — resolve relative to hooks/ (path is hooks-relative, e.g. ../mods/...)
    for (const mod of hooksJson.modules ?? []) {
      const abs = resolve(hooksDir, mod);
      try { readFileSync(abs); }
      catch { missing.push(`module: ${mod}`); }
    }

    // commands — extract and strip ${CLAUDE_PLUGIN_ROOT}/ prefix (repo-root-relative)
    const extractPaths = (val: unknown): string[] => {
      const out: string[] = [];
      if (typeof val === "string") {
        for (const m of val.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./+\-]+)/g))
          out.push(m[1]);
      } else if (Array.isArray(val)) for (const i of val) out.push(...extractPaths(i));
      else if (val != null && typeof val === "object")
        for (const v of Object.values(val as Record<string, unknown>))
          out.push(...extractPaths(v));
      return out;
    };

    const hooks = hooksJson.hooks ?? {};
    for (const _ of Object.values(hooks)) {
      const group = _ as unknown[];
      for (const entry of group) {
        const hooksArr = (entry as Record<string, unknown>)?.hooks;
        if (Array.isArray(hooksArr)) {
          for (const h of hooksArr) {
            const cmd = (h as Record<string, unknown>)?.command;
            for (const ref of extractPaths(cmd)) {
              const abs = join(root, ref);
              try { readFileSync(abs); }
              catch { missing.push(ref); }
            }
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
