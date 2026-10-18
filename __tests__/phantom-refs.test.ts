import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetPhantomRefCache,
  envCredential,
  isPhmRef,
  resolveCredential,
  runPhantomReveal,
} from "../servers/_phantom-refs.ts";

beforeEach(() => _resetPhantomRefCache());

describe("isPhmRef", () => {
  test("accepts phm:NAME, rejects others", () => {
    expect(isPhmRef("phm:ANTHROPIC_API_KEY")).toBe(true);
    expect(isPhmRef(" phm:a.b-c ")).toBe(true);
    for (const v of [undefined, "", "phm:", "phm:bad name", "phm:a;b", "sk-abc", "PHM:X"]) {
      expect(isPhmRef(v)).toBe(false);
    }
  });
});

describe("resolveCredential", () => {
  test("plain values pass through without running phantom", () => {
    let calls = 0;
    const run = () => (calls++, "x");
    expect(resolveCredential("sk-test-123", run)).toBe("sk-test-123");
    expect(resolveCredential("  sk-test-123  ", run)).toBe("sk-test-123");
    expect(calls).toBe(0);
  });
  test("empty and unset are undefined", () => {
    expect(resolveCredential(undefined)).toBeUndefined();
    expect(resolveCredential("   ")).toBeUndefined();
  });
  test("phm ref resolves through the runner and is cached", () => {
    const seen: string[] = [];
    const run = (n: string) => (seen.push(n), "resolved-value");
    expect(resolveCredential("phm:MY_KEY", run)).toBe("resolved-value");
    expect(resolveCredential("phm:MY_KEY", run)).toBe("resolved-value");
    expect(seen).toEqual(["MY_KEY"]);
  });
  test("phantom absent or failing: ref is unset, never the literal ref", () => {
    expect(resolveCredential("phm:MY_KEY", () => undefined)).toBeUndefined();
  });
  test("malformed ref never reaches the runner", () => {
    let calls = 0;
    expect(resolveCredential("phm:a b;rm", () => (calls++, "x"))).toBeUndefined();
    expect(calls).toBe(0);
  });
  test("envCredential reads the named variable", () => {
    expect(envCredential("K", { K: "phm:K" }, () => "v")).toBe("v");
    expect(envCredential("K", {}, () => "v")).toBeUndefined();
  });
});

describe("default runner without phantom", () => {
  test("missing phantom binary degrades to undefined", () => {
    const old = process.env.PATH;
    process.env.PATH = "/nonexistent-dir";
    try {
      expect(runPhantomReveal("ANYTHING")).toBeUndefined();
    } finally {
      process.env.PATH = old;
    }
  });
});
