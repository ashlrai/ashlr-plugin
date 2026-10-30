import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectTests, scan } from "../scripts/baseline-scan";
import { renderArchitectureMd, renderWorkspaceMd } from "../scripts/genome-init";
import { buildReport } from "../scripts/session-log-report";
import { parseFile } from "../servers/_ast-helpers";
import { applyRangeEdits, planExtractFunction } from "../servers/_ast-refactor";

const root = resolve(import.meta.dir, "..");
const scratch: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "sonar-q13-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function crashCli() {
  const home = temp();
  const dir = join(home, ".ashlr", "crashes");
  mkdirSync(dir, { recursive: true });
  for (const offset of [0, 1]) {
    const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(dir, `${date}.jsonl`), JSON.stringify({ ts: date, tool: `tool${offset}`, message: "fixture", args: "{}" }));
  }
  return (args: string[], input = "") => spawnSync(process.execPath, [join(root, "scripts/report-crash.ts"), ...args], {
    encoding: "utf8", input, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
  });
}

describe("Sonar Q13 sort and crash regressions", () => {
  test("targeted files require explicit sorting comparators", () => {
    for (const path of [
      "scripts/baseline-scan.ts", "scripts/genome-init.ts", "scripts/report-crash.ts",
      "scripts/session-log-report.ts", "servers/_ast-refactor/extract-function.ts",
      "servers/_bash-summarizers-registry.ts", "servers/_genome-search.ts",
      "site/app/admin/overview/page.tsx", "site/scripts/freshness.ts", "vscode/src/stats-reader.ts",
    ]) expect(readFileSync(join(root, path), "utf8")).not.toMatch(/\.sort\(\s*\)/);
  });

  test("baseline locations, workspace keys and tree names retain code-unit order", () => {
    const dir = temp();
    for (const name of ["zeta", "Zulu", "_local"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, `${name}.ts`), "");
    }
    expect(detectTests(["spec/a.ts", "tests/a.ts", "__tests__/a.ts", "a.test.ts"], dir).locations)
      .toEqual(["*.test.ts", "__tests__/", "spec/", "test/"]);
    const workspace = renderWorkspaceMd({ rootDir: dir, projects: [], orgs: new Map(["a!", "a", "Z"].map((key) => [key, []])) });
    expect(workspace.match(/^### .+$/gm)).toEqual(["### Z (0 repos)", "### a (0 repos)", "### a! (0 repos)"]);
    const tree = renderArchitectureMd(scan({ dir, home: temp(), noCache: true }));
    expect(tree.match(/^├── .+$/gm)).toEqual(["├── Zulu/", "├── _local/", "├── zeta/", "├── Zulu.ts", "├── _local.ts", "├── zeta.ts"]);
  });

  test("fallback rows sort by tool and reason keys, including prefix keys", () => {
    const home = temp();
    mkdirSync(join(home, ".ashlr"));
    const rows = ["a!", "a", "Z"].flatMap((tool) => ["x!", "x"].map((reason) =>
      JSON.stringify({ ts: new Date().toISOString(), event: "tool_fallback", tool, reason })));
    writeFileSync(join(home, ".ashlr", "session-log.jsonl"), rows.join("\n"));
    const report = buildReport({ home });
    expect(report.split("\n").filter((line) => line.includes("fallback:")).map((line) => line.trim().split(/\s{2,}/).slice(0, 2).join(" ")))
      .toEqual(["Z tool_fallback:x", "Z tool_fallback:x!", "a tool_fallback:x", "a tool_fallback:x!", "a! tool_fallback:x", "a! tool_fallback:x!"]);
  });

  test("extract-function returns multiple outputs in code-unit order", async () => {
    const body = "let zebra = 1; let Alpha = 2; let _local = 3;";
    const src = `export function main() { ${body} console.log(zebra, Alpha, _local); }`;
    const path = join(temp(), "sample.ts");
    writeFileSync(path, src);
    const parsed = await parseFile(path);
    expect(parsed).not.toBeNull();
    const plan = planExtractFunction(parsed!, { newFunctionName: "extract", start: src.indexOf(body), end: src.indexOf(body) + body.length });
    expect(plan.ok).toBe(true);
    expect(applyRangeEdits(plan.source!, plan.edits!)).toContain("return { Alpha, _local, zebra };");
  });

  test("crash discovery selects newest dump and prompts preserve acceptance and EOF", () => {
    const run = crashCli();
    expect(JSON.parse(run(["--stdout"]).stdout).tool).toBe("tool0");
    expect(run(["--all", "--stdout"]).stdout.trim().split("\n").map((line) => JSON.parse(line).tool)).toEqual(["tool0", "tool1"]);
  });

  test.each([["", false], ["n\n", false], ["maybe\n", false], ["\n", true], [" Y \n", true], ["YES\n", true]] as const)("confirmation input %j accepts=%j", (input, accepted) => {
    const result = crashCli()(["--endpoint", "http://127.0.0.1:1"], input);
    expect(result.status).toBe(accepted ? 3 : 2);
    expect(result.stderr).toContain(accepted ? "upload failed" : "Declined.");
  });
});
