import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../servers/_crash-dump.ts";
import { CRED_KEY, CRED_VALUE, fleetAuthor } from "../scripts/fleet-author.ts";
import { fleetSpawn } from "../scripts/fleet-spawn.ts";
import { DISPATCH_LINE, fleetThread } from "../scripts/fleet-thread.ts";

// The two S8786-flagged patterns, kept verbatim to prove the rewrites match identically.
const OLD_LINE = /^\[?(\d{4}-\d\d-\d\dT[^\s\]]+)\]?\s+([\w.-]+)(?:\s+.*)?$/;
const OLD_CRED = /((["']?[\w-]*(?:token|secret|password|api[_-]?key)["']?)\s*[:=]\s*)("(?:[^"\n]*)"|'[^'\n]*'|[^\s,;]+)/gi;
const redact = (text: string) => text.replace(CRED_VALUE, (match, key: string, separator: string) =>
  CRED_KEY.test(key.replace(/["']$/, "")) ? key + separator + "[REDACTED]" : match);
const match3 = (line: string, re: RegExp) => {
  const match = line.match(re);
  return match ? [match[0], match[1], match[2]] : null;
};

const heads = ["", "[", "[2026-10-30T12:00:00Z", "[2026-10-30T12:00:00Z]", "2026-10-30T08:02:00-04:00",
  "2026-10-30T12:00:00.123Z]", "2026-10-30T", "[x]", "2026-10-30", "[]", "[2026-10-30T12:00:00Z]]",
  "2026-1-30Tx", "12345-10-30T", "[2026-10-30T a"];
const gaps = ["", " ", "  ", "\t", "x", " ]", "] "];
const types = ["dispatched", "ev-1", "a.b", "a", "TYPE_", "-x", ".y", "z9", "a_b"];
const tails = ["", " job=x", "  job=x  extra", " !bang", "\txyz", " ", "  ", " ]", "\r", "x"];

test("dispatch-line regex matches identically to the flagged pattern", () => {
  for (const head of heads) for (const gap of gaps) for (const type of types) for (const tail of tails) {
    const line = head + gap + type + tail;
    expect(match3(line, DISPATCH_LINE)).toEqual(match3(line, OLD_LINE));
  }
});

const keys = ["", "'", '"', "x", "ab", "token", "secret", "password", "api_key", "apikey", "api-key",
  "my_token", "x-token", "token_", "tokenx", "xtoken", "secretly", "tokenize", "API_KEY", "Secret",
  "token'", "\"token", "x'token", "x'token'", "'token'", "a'b'token", "token''",
  "étoken", "-token", "_token", "!token", "a_b", "0k", "P4SSW0RD", "pass", "sec", "key", "token-secret", "notoken"];
const separators = ["=", ":", " =", " :", "= ", ": ", " = ", "  =  ", "'=", "\"=", "' =", "\" =", "", " \t=\t"];
const values = ["v", "abc", "a b", "a,b", "a;b", "'quoted'", "\"dq\"", "''", "\"\"", "'a b'", "=v", ":v",
  ";", ",", "!x", "v=w", "x'y", ""];
const contexts = ["", "prefix ", "INFO ", "ERR x=1 ", " mid", ";tail", ",end", "'q' ", " \"d\" "];

test("credential redaction produces identical output to the flagged pattern", () => {
  const corpus: string[] = [];
  for (const key of keys) for (const separator of separators) for (const value of values) {
    corpus.push(key + separator + value);
    for (const context of contexts) corpus.push(context + key + separator + value);
  }
  for (const line of corpus) {
    expect(redact(line)).toBe(line.replace(OLD_CRED, "$1[REDACTED]"));
  }
});

test("credential redaction still fires through fleetAuthor on the real path", () => {
  const report = fleetAuthor("", 'ERROR OPENAI_API_KEY=fixture-value GITHUB_TOKEN="fixture value"', Buffer.alloc(0));
  expect(report.last_codex_error).toBe('ERROR OPENAI_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]');
  expect(fleetAuthor("", "ERROR token=fixture-credential", Buffer.alloc(0)).last_codex_error)
    .toBe("ERROR token=[REDACTED]");
});

test("production redact chain matches the flagged pattern on sampled lines", () => {
  // Reference: the old pattern inside the same surrounding chain.
  const reference = (line: string) => redactSecrets(line)
    .replace(OLD_CRED, "$1[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
    .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, "[REDACTED]").slice(0, 1000);
  let n = 0;
  for (const key of keys) for (const separator of separators) for (const value of values) {
    if (++n % 89) continue;
    const line = `ERROR ${key}${separator}${value}`;
    expect(fleetAuthor("", line, Buffer.alloc(0)).last_codex_error).toBe(reference(line));
  }
});

test("a long hostile credential line redacts in well under 50ms", () => {
  for (const hostile of ["x".repeat(200_000), "x".repeat(200_000) + "=v",
    "token".repeat(30_000), "abc ".repeat(50_000) + "=v", "'".repeat(100_000) + "token=v"]) {
    const start = performance.now();
    redact(`ERROR ${hostile}`);
    expect(performance.now() - start).toBeLessThan(50);
  }
  const start = performance.now();
  fleetAuthor("", `ERROR ${"x".repeat(200_000)}token=v`, Buffer.alloc(0));
  expect(performance.now() - start).toBeLessThan(50);
});

test("long dispatch and jobs text parse in well under 50ms", () => {
  const id = "RQ-1.test_2";
  const dispatch = `[2026-10-30T${"z".repeat(200_000)}] ev job=${id}\n` +
    `2026-10-30T12:00:00Z dispatched job=${id} ${"detail ".repeat(30_000)}`;
  const start = performance.now();
  fleetThread(id, "", dispatch);
  expect(performance.now() - start).toBeLessThan(50);
  expect(match3(dispatch.split("\n")[1]!, DISPATCH_LINE)?.[1]).toBe("2026-10-30T12:00:00Z");
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("ambiguous repo names sort locale-aware, not by code unit (S2871)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-regex-safety-")));
  roots.push(root);
  // "aa/dup" precedes "Zz/dup" alphabetically; UTF-16 code units order them the other way.
  mkdirSync(join(root, "mirrors", "Zz__dup"), { recursive: true });
  mkdirSync(join(root, "mirrors", "aa__dup"), { recursive: true });
  expect(() => fleetSpawn(["work", "--repo", "dup"], new Date("2026-10-30T12:00:00Z"), root))
    .toThrow("ambiguous fleet repo: aa/dup, Zz/dup");
});
