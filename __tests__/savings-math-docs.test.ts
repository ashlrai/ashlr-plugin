import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "site/content/docs/concepts/savings-math.mdx"), "utf8");
const commands = [...doc.matchAll(/^ashlr-plugin (stats [^\n]+)$/gm)].map(match => match[1]!.split(" "));
let fixtureHome: string;

beforeEach(() => { fixtureHome = mkdtempSync(join(tmpdir(), "savings-math-docs-")); });
afterEach(() => { rmSync(fixtureHome, { recursive: true, force: true }); });

function run(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    input: options.input,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      ASHLR_HOME_OVERRIDE: fixtureHome,
      ASHLR_STATS_SYNC: "1",
      ASHLR_TELEMETRY: "off",
      ASHLR_LLM_PROVIDER: "off",
      ...options.env,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function statsExamples() {
  expect(commands).toHaveLength(3);
  return commands.map(args => JSON.parse(run([join(root, "scripts/cli.ts"), ...args])));
}

test("documented stats commands read actual v2 ledger entries and slices", () => {
  // Populate through the real writer so the examples cannot silently depend on
  // the retired v1 .session shape or mistake byTool token counts for bytes.
  run(["-e", `
    import { recordSaving } from ${JSON.stringify(join(root, "servers/_stats.ts"))};
    await recordSaving(4000, 1000, "ashlr__read", { sessionId: "example-session" });
    await recordSaving(100, 200, "ashlr__edit", { sessionId: "example-session" });
  `]);
  const [ledger, tool, session] = statsExamples();
  expect(ledger.schemaVersion).toBe(2);
  expect(ledger.lifetime).toMatchObject({ calls: 2, tokensSaved: 750, rawTotal: 1025 });
  expect(tool).toEqual({ schema: "ashlr-plugin.stats.v1", calls: 1, tokensSaved: 750 });
  expect(session).toEqual({ schema: "ashlr-plugin.stats.v1", ...ledger.sessions["example-session"] });
  expect(ledger.lifetime.measuredCalls ?? 0).toBe(0);
  expect(doc).toContain("max(0, ceil((rawBytes - compactBytes) / 4))");
  expect(readFileSync(join(root, "site/content/docs/concepts/stats-schema.mdx"), "utf8"))
    .toContain("max(0, ceil((rawBytes - compactBytes) / 4))");
  expect(doc).toContain("`measurementMode: \"estimate\"`");
  expect(doc).toContain("`byTool` maps contain `calls` and `tokensSaved`");
});

test("documented missing-slice JSON matches an unused install", () => {
  const [ledger, tool, session] = statsExamples();
  expect(ledger.sessions).toEqual({});
  const missing = { schema: "ashlr-plugin.stats.v1", value: null };
  expect(tool).toEqual(missing);
  expect(session).toEqual(missing);
  expect(doc).toContain(JSON.stringify(missing));
});

test("edit baseline explanation follows the current single and multi-edit accounting", () => {
  const edit = readFileSync(join(root, "servers/edit-server.ts"), "utf8");
  const multiEdit = readFileSync(join(root, "servers/multi-edit-server.ts"), "utf8");
  expect(edit).toContain("const baseBytes = search.length + replace.length;");
  expect(edit).toContain("!strict && count > 1 ? baseBytes + 500 : baseBytes");
  expect(multiEdit).toContain("baseline += h.search.length + h.replace.length;");
  expect(doc).toContain("`search.length + replace.length`");
  expect(doc).toContain("500-character context allowance once");
  expect(doc).toContain("Neither tool uses the complete file before and after");
});

test("README quiet flag keeps the executable CLI summary", () => {
  const output = run([join(root, "scripts/cli.ts"), "genome-refresh", "--quiet", "--dry-run"]);
  expect(output).toBe("[ashlr] genome refresh: 0 files, 0 updated, 0 invalidated, 0 genome root(s)");
  expect(readFileSync(join(root, "README.md"), "utf8"))
    .toContain("`--quiet` silences worker messages but keeps the CLI summary");
});

test("documented Bash hook modes suggest a tool without redirecting the native call", () => {
  for (const mode of ["redirect", "nudge", "off"]) {
    const output = JSON.parse(run([join(root, "hooks/pretooluse-bash.ts")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git log --oneline -20" } }),
      env: { ASHLR_HOOK_MODE: mode },
    })).hookSpecificOutput;
    expect(output.hookEventName).toBe("PreToolUse");
    expect(output.permissionDecision).toBeUndefined();
    if (mode === "off") expect(output.additionalContext).toBeUndefined();
    else expect(output.additionalContext).toContain("ashlr__bash");
  }
  expect(doc).toContain("in both `redirect` and `nudge` modes");
  expect(doc).toContain("It never blocks or redirects the native Bash call");
  expect(doc).toContain("`ASHLR_HOOK_MODE=off` disables the suggestion");
  expect(readFileSync(join(root, "README.md"), "utf8"))
    .toContain("The Bash hook only suggests `ashlr__bash`");
});
