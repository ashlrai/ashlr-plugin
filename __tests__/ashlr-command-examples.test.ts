import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const examples = read("docs/ashlr-command-examples.md");

test("examples are labeled and discoverable from the command reference", () => {
  expect(examples).toContain("These examples are illustrative");
  expect(read("docs/commands.md")).toContain("(ashlr-command-examples.md)");
  expect(read("docs/README.md")).toContain("(ashlr-command-examples.md)");
});

test("parallelize examples follow the documented invocation and report", () => {
  const source = read("commands/ashlr-parallelize.md");
  const invocation = '/ashlr-parallelize "explain what this module exports" servers/_pid-alive.ts servers/_run-with-timeout.ts';
  const editInvocation = '/ashlr-parallelize --code "add JSDoc to all exported functions" servers/read-server.ts servers/grep-server.ts';
  for (const value of [invocation, editInvocation]) {
    expect(examples).toContain(value);
    expect(source).toContain(value);
  }
  const report = source.split("## Illustrative output\n")[1].match(/```\n([\s\S]*?)\n```/)?.[1];
  expect(report).toBeDefined();
  expect(examples).toContain(`\`\`\`text\n${report}\n\`\`\``);
  expect(examples).toContain("subagent_type: ashlr:ashlr:code");
  expect(source).toContain("with `--code`, it would show `ashlr:ashlr:code` instead");
  const error = "No files specified. Usage: /ashlr-parallelize <task> <file1> [file2] ...";
  expect(examples).toContain(error);
  expect(source.replaceAll("`", "")).toContain(error);
});

test("budget and empty-cache examples match their command instructions", () => {
  const budget = read("commands/ashlr-budget.md");
  expect(examples).toContain("/ashlr-budget tokens=200000\nBudget set to 200000 tokens.");
  expect(budget).toContain("/ashlr-budget tokens=200000");
  expect(budget.replaceAll("`", "").replaceAll("<N>", "200000")).toContain("Budget set to 200000 tokens.");
  const empty = "No orchestration runs yet — use /ashlr-orchestrate to start.";
  expect(examples).toContain(`/ashlr-orchestrate-status\n${empty}`);
  expect(read("commands/ashlr-orchestrate-status.md")).toContain(empty);
});
