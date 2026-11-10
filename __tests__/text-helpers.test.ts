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
  test("deduplicates mixed-case variants into one lowercase keyword at its first position", () => {
    expect(extractKeywords("Router ROUTER router")).toEqual(["router"]);
    expect(extractKeywords("Queue CACHE queue Cache router")).toEqual(["queue", "cache", "router"]);
    expect(extractKeywords("Session SESSION handling session")).toEqual(["session", "handling"]);
    expect(extractKeywords("Parse_Config PARSE_CONFIG parse_config")).toEqual(["parse_config"]);
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
