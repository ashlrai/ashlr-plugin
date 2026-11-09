import { describe, expect, test } from "bun:test";
import { STOPWORDS, extractKeywords } from "../servers/_text-helpers.ts";

describe("extractKeywords", () => {
  test("keeps content words and drops stopwords", () => {
    expect(extractKeywords("how does auth work")).toEqual(["auth"]);
    expect(extractKeywords("explain the session handling")).toEqual(["session", "handling"]);
  });
  test("lowercases and splits on non-alphanumeric boundaries, keeping underscores", () => {
    expect(extractKeywords("Parse_Config, then LoadSettings!")).toEqual(["parse_config", "loadsettings"]);
    expect(extractKeywords("src/server-utils.ts")).toEqual(["server", "utils"]);
  });
  test("drops tokens of three characters or fewer", () => {
    expect(extractKeywords("api db ssl tls auth")).toEqual(["auth"]);
  });
  test("deduplicates and preserves first-occurrence order", () => {
    expect(extractKeywords("router cache router queue cache")).toEqual(["router", "cache", "queue"]);
  });
  test("underscores stay inside tokens: snake_case is one keyword, not split", () => {
    expect(extractKeywords("load_user_config")).toEqual(["load_user_config"]);
    expect(extractKeywords("max_retries and retry_delay")).toEqual(["max_retries", "retry_delay"]);
  });
  test("leading, trailing and doubled underscores are preserved", () => {
    expect(extractKeywords("_private __dunder__ trailing_")).toEqual(["_private", "__dunder__", "trailing_"]);
  });
  test("underscore length counts toward the three-character cutoff", () => {
    expect(extractKeywords("a_b _x_ ab_c abc_")).toEqual(["ab_c", "abc_"]);
    expect(extractKeywords("___ __")).toEqual([]);
  });
  test("deduplicates repeated underscore tokens, case-insensitively", () => {
    expect(extractKeywords("parse_config PARSE_CONFIG parse_config load_env Load_Env")).toEqual([
      "parse_config", "load_env",
    ]);
  });
  test("an underscored token is distinct from its split parts", () => {
    expect(extractKeywords("parse_config parse config parse_config")).toEqual(["parse_config", "parse", "config"]);
  });
  test("underscore-joined stopwords are not filtered", () => {
    expect(extractKeywords("code_file using_code")).toEqual(["code_file", "using_code"]);
  });
  test("empty, whitespace and punctuation-only input give no keywords", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("   \n\t")).toEqual([]);
    expect(extractKeywords("?!...--")).toEqual([]);
  });
  test("empty input returns an independent empty result after other calls", () => {
    expect(extractKeywords("router cache")).toEqual(["router", "cache"]);
    const empty = extractKeywords("");
    expect(empty).toEqual([]);
    empty.push("modified");
    expect(extractKeywords("")).toEqual([]);
  });
  test("returns no keywords when every token is filtered", () => {
    expect(extractKeywords("the api and work")).toEqual([]);
  });
  test("non-ASCII letters act as separators", () => {
    expect(extractKeywords("café latte")).toEqual(["latte"]);
  });
  test("handles Unicode case conversion and supplementary-character boundaries", () => {
    expect(extractKeywords("KELVIN🚀router𐐀CACHE kelvin")).toEqual([
      "kelvin", "router", "cache",
    ]);
  });
  test("every stopword over three characters is filtered", () => {
    for (const w of STOPWORDS) if (w.length > 3) expect(extractKeywords(w)).toEqual([]);
  });
});
