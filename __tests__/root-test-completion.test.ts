import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { discoverRootTests, readRootTestCompletion, verifyRootTestCompletion } from "../scripts/root-test-completion";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(sources: Record<string, string>, isolated = true, ciMetadata = false) {
  const root = mkdtempSync(join(tmpdir(), "root-completion-"));
  temporary.push(root);
  mkdirSync(join(root, "__tests__"));
  const home = join(root, "home"); mkdirSync(home);
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(root, "__tests__", name), source);
  const report = join(root, "child-owned.xml");
  const result = spawnSync(process.execPath, ["test", ...(isolated ? ["--parallel=4"] : []), "--reporter=junit", `--reporter-outfile=${report}`, "__tests__"], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: process.env.CI,
      ...(ciMetadata ? { GITHUB_ACTIONS: "true", GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example/fixture", GITHUB_RUN_ID: "12345", GITHUB_SHA: "a".repeat(40) } : {}) },
  });
  return { root, report, result, inventory: discoverRootTests(root) };
}

function completed() {
  return fixture({
    "first.test.ts": 'import {describe,test,expect} from "bun:test";describe("outer",()=>{describe("inner",()=>{test("name > & \\"quoted\\"",()=>{console.error("(fail) nested child fixture\\n0 pass\\n1 fail");expect(true).toBe(true)});test.skip("existing skip",()=>{});});});',
    "second.test.ts": 'import {test,expect} from "bun:test";test("second file",()=>expect(2).toBe(2));',
  });
}

test("actual Bun receipt proves full file inventory; nested failure text is not a suite failure", () => {
  const f = completed();
  expect(f.result.status).toBe(0);
  expect(f.result.stderr).toContain("(fail) nested child fixture");
  expect(readRootTestCompletion(f.report, f.inventory, f.root)).toMatchObject({ files: 2, tests: 3, assertions: 2, skipped: 1, failures: 0 });
});

test("an actual test calling exit0 cannot qualify without a completed child receipt", () => {
  const f = fixture({
    "exit.test.ts": 'import {test} from "bun:test";test("early exit",()=>process.exit(0));',
    "unreached.test.ts": 'import {test,expect} from "bun:test";test("must be accounted for",()=>expect(true).toBe(true));',
  }, false);
  expect(f.result.status).toBe(0);
  expect(() => readRootTestCompletion(f.report, f.inventory, f.root)).toThrow();
});

test("actual failed Bun cases remain failures even if a caller disregards their exit status", () => {
  const f = fixture({ "failed.test.ts": 'import {test,expect} from "bun:test";test("fails",()=>expect(1).toBe(2));' });
  expect(f.result.status).toBe(1);
  expect(() => readRootTestCompletion(f.report, f.inventory, f.root)).toThrow();
});

test("truncated, contradictory, duplicate and foreign-file receipts fail closed", () => {
  const f = completed();
  expect(f.result.status).toBe(0);
  const xml = readFileSync(f.report, "utf8");
  const suite = xml.match(/^  <testsuite [\s\S]*?^  <\/testsuite>/m)?.[0];
  if (!suite) throw new Error("Fixture reporter did not emit a suite");
  const corruptions = [
    xml.replace("</testsuites>", ""),
    xml.replace('tests="3"', 'tests="4"'),
    xml.replace('failures="0"', 'failures="1"'),
    xml.replace(suite, ""),
    xml.replace("</testsuites>", `${suite}\n</testsuites>`),
    xml.replace('name="bun test"', 'name="bun test" errors="1"'),
    xml.replace('name="bun test"', 'name="bun test" name="duplicate"'),
    xml.replace('name="bun test"', 'name="&unknown;"'),
    xml.replace('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE testsuites SYSTEM "https://example.invalid/external">'),
    `${xml}<testsuites />`,
  ];
  for (const changed of corruptions) expect(() => verifyRootTestCompletion(changed, f.inventory, f.root)).toThrow();
  expect(() => verifyRootTestCompletion(xml, f.inventory.slice(0, 1), f.root)).toThrow();
  expect(() => verifyRootTestCompletion(xml, [...f.inventory, f.inventory[0]!], f.root)).toThrow();
});

test("a stale alias or non-file cannot stand in for the fresh child report", () => {
  const f = completed();
  expect(f.result.status).toBe(0);
  const alias = join(f.root, "report-alias.xml");
  linkSync(f.report, alias);
  expect(() => readRootTestCompletion(alias, f.inventory, f.root)).toThrow();
  expect(() => readRootTestCompletion(f.report, f.inventory, f.root)).toThrow();
  expect(() => readRootTestCompletion(f.root, f.inventory, f.root)).toThrow();
});


test("actual hosted Bun CI annotations are inert and cannot replace completion evidence", () => {
  const f = fixture({ "ci.test.ts": 'import {describe,test,expect} from "bun:test";describe("nested",()=>{test("complete",()=>expect(true).toBe(true));});' }, true, true);
  expect(f.result.status).toBe(0);
  const xml = readFileSync(f.report, "utf8");
  expect(xml).toContain('<property name="ci"');
  expect(xml).toContain('<property name="commit"');
  expect(readRootTestCompletion(f.report, f.inventory, f.root)).toMatchObject({ files: 1, tests: 1, failures: 0, errors: 0 });
  const property = xml.match(/<property name="ci"[^>]*\/>/)?.[0];
  if (!property) throw new Error("Actual CI reporter omitted its annotation");
  for (const changed of [
    xml.replace(property, property + property),
    xml.replace('name="ci" value=', 'name="authority" value='),
    xml.replace(property, '<property name="ci" />'),
    xml.replace(property, property.replace('/>', '><testcase /></property>')),
    xml.replace('</properties>', '<failure /></properties>'),
    xml.replace('assertions="1"', 'assertions="9"'),
  ]) expect(() => verifyRootTestCompletion(changed, f.inventory, f.root)).toThrow();
});
