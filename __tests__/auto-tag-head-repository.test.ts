import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/auto-tag.yml", "utf8");
const expression = workflow.match(/\n  tag:\n    if: ([^\n]+)/)?.[1];
if (!expression) throw new Error("Missing actual tag job condition");

type Fixture = { event: string; ref: string; repository: string; source?: string; conclusion?: string; head?: string };
// Evaluate only the actual condition's closed equality/boolean grammar, without eval.
function allowed(source: string, fixture: Fixture): boolean {
  const tokens = source.match(/github(?:\.[A-Za-z_][A-Za-z0-9_]*)+|'[^']*'|&&|\|\||==|\(|\)/g) ?? [];
  if (tokens.join("") !== source.replace(/\s+/g, "")) throw new Error("Unsupported condition syntax");
  const values: Record<string, string | undefined> = {
    "github.event_name": fixture.event, "github.ref": fixture.ref,
    "github.repository": fixture.repository,
    "github.event.workflow_run.event": fixture.source,
    "github.event.workflow_run.conclusion": fixture.conclusion,
    "github.event.workflow_run.head_repository.full_name": fixture.head,
  };
  let offset = 0;
  const value = (): string | undefined => {
    const token = tokens[offset++];
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (!token || !Object.hasOwn(values, token)) throw new Error("Unknown condition field");
    return values[token];
  };
  const primary = (): boolean => {
    if (tokens[offset] === "(") {
      offset++; const result = disjunction();
      if (tokens[offset++] !== ")") throw new Error("Unclosed condition");
      return result;
    }
    const left = value();
    if (tokens[offset++] !== "==") throw new Error("Unsupported comparison");
    const right = value();
    return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
  };
  const conjunction = (): boolean => {
    let result = primary();
    while (tokens[offset] === "&&") { offset++; const next = primary(); result = result && next; }
    return result;
  };
  const disjunction = (): boolean => {
    let result = conjunction();
    while (tokens[offset] === "||") { offset++; const next = conjunction(); result = result || next; }
    return result;
  };
  const result = disjunction();
  if (offset !== tokens.length) throw new Error("Trailing condition tokens");
  return result;
}
const run = (head?: string): Fixture => ({ event: "workflow_run", ref: "refs/heads/main", repository: "ashlrai/ashlr-plugin", source: "push", conclusion: "success", head });

test("auto-tag accepts successful source pushes from the same repository", () => {
  expect(allowed(expression, run("ashlrai/ashlr-plugin"))).toBe(true);
});
test("auto-tag refuses a successful fork source push at the actual job boundary", () => {
  const fork = run("synthetic-fork/ashlr-plugin");
  expect(allowed(expression, fork)).toBe(false);
  const previous = expression.replace(" && github.event.workflow_run.head_repository.full_name == github.repository", "");
  expect(allowed(previous, fork)).toBe(true);
});
test("auto-tag refuses a source run without head-repository evidence", () => {
  expect(allowed(expression, run())).toBe(false);
});
test("auto-tag preserves canonical push and manual-main paths", () => {
  const base = { ref: "refs/heads/main", repository: "ashlrai/ashlr-plugin" };
  expect(allowed(expression, { ...base, event: "push" })).toBe(true);
  expect(allowed(expression, { ...base, event: "workflow_dispatch" })).toBe(true);
  expect(allowed(expression, { ...base, event: "workflow_dispatch", ref: "refs/heads/other" })).toBe(false);
});
test("auto-tag still refuses unsuccessful or non-push source runs", () => {
  expect(allowed(expression, { ...run("ashlrai/ashlr-plugin"), conclusion: "failure" })).toBe(false);
  expect(allowed(expression, { ...run("ashlrai/ashlr-plugin"), source: "pull_request" })).toBe(false);
});
