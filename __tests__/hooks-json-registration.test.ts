/**
 * hooks-json-registration.test.ts — guardrail that critical hook scripts
 * are actually wired up in hooks/hooks.json.
 *
 * Why this exists: in v1.25 the posttooluse-stale-result.ts hook was added
 * but never registered, so the entire multi-turn-stale feature shipped as
 * dead code. This test asserts every hook that's been declared "critical"
 * is referenced from hooks/hooks.json under the correct event.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const HOOKS_JSON = resolve(import.meta.dir, "..", "hooks", "hooks.json");
const HOOKS_DIR = resolve(import.meta.dir, "..", "hooks");

interface HookEntry { type: string; command: string }
interface HookGroup { matcher?: string; hooks: HookEntry[] }
interface HooksJson { hooks: Record<string, HookGroup[]> }

function loadHooks(): HooksJson {
  const raw = readFileSync(HOOKS_JSON, "utf-8");
  return JSON.parse(raw) as HooksJson;
}

function flattenCommands(events: string[], cfg: HooksJson): string[] {
  const out: string[] = [];
  for (const event of events) {
    const groups = cfg.hooks[event] ?? [];
    for (const g of groups) for (const h of g.hooks) out.push(h.command);
  }
  return out;
}

/**
 * (file, [event...]): assert the hook script is referenced under at least one
 * of the given Claude Code event names.
 */
const CRITICAL_HOOKS: Array<{ file: string; events: string[]; matcherIncludes?: string[] }> = [
  // v1.25 multi-turn stale tracker — recording fires on read-class tools.
  {
    file: "posttooluse-stale-result.ts",
    events: ["PostToolUse"],
    matcherIncludes: ["Read", "Grep"],
  },
  // Always-on session header.
  { file: "session-start.ts", events: ["SessionStart"] },
  // Genome scribe + cloud push at session end.
  { file: "post-tool-use-genome.ts", events: ["PostToolUse"] },
];

describe("hooks/hooks.json registration", () => {
  it("file exists and is valid JSON", () => {
    expect(existsSync(HOOKS_JSON)).toBe(true);
    expect(() => loadHooks()).not.toThrow();
  });

  for (const spec of CRITICAL_HOOKS) {
    it(`registers ${spec.file} under ${spec.events.join("|")}`, () => {
      const hookPath = resolve(HOOKS_DIR, spec.file);
      expect(existsSync(hookPath)).toBe(true);

      const cfg = loadHooks();
      const cmds = flattenCommands(spec.events, cfg);
      const found = cmds.find((c) => c.includes(spec.file));
      expect(found, `expected ${spec.file} referenced in ${spec.events.join("|")}`).toBeDefined();

      if (spec.matcherIncludes) {
        const groups = spec.events.flatMap((e) => cfg.hooks[e] ?? []);
        const owningGroup = groups.find((g) =>
          g.hooks.some((h) => h.command.includes(spec.file)),
        );
        expect(owningGroup).toBeDefined();
        for (const must of spec.matcherIncludes) {
          expect(owningGroup!.matcher ?? "").toContain(must);
        }
      }
    });
  }
});
