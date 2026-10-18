import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  anthropicBaseUrl,
  ollamaBaseUrl,
  openaiBaseUrl,
} from "../servers/_base-urls.ts";
import { OLLAMA_BASE_URL, fetchTags } from "../scripts/ollama-setup.ts";

describe("defaults are unchanged", () => {
  test("hosts match what the plugin always called", () => {
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(DEFAULT_OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
    expect(DEFAULT_OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(OLLAMA_BASE_URL).toBe("http://localhost:11434");
  });
  test("unset, empty and whitespace-only values fall back", () => {
    for (const v of [undefined, "", "   ", "/", " // "]) {
      expect(anthropicBaseUrl({ ANTHROPIC_BASE_URL: v })).toBe(DEFAULT_ANTHROPIC_BASE_URL);
      expect(openaiBaseUrl({ OPENAI_BASE_URL: v })).toBe(DEFAULT_OPENAI_BASE_URL);
      expect(ollamaBaseUrl({ OLLAMA_HOST: v })).toBe(DEFAULT_OLLAMA_BASE_URL);
    }
  });
});

describe("overrides are honored", () => {
  test("anthropic and openai: used as given, trailing slashes trimmed", () => {
    expect(anthropicBaseUrl({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" })).toBe("http://127.0.0.1:4000");
    expect(anthropicBaseUrl({ ANTHROPIC_BASE_URL: " https://gw.example/anthropic/// " })).toBe("https://gw.example/anthropic");
    expect(openaiBaseUrl({ OPENAI_BASE_URL: "http://127.0.0.1:4000/v1/" })).toBe("http://127.0.0.1:4000/v1");
  });
  test("ollama: host:port without a scheme gets http://", () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: "192.168.1.5:9999" })).toBe("http://192.168.1.5:9999");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "gpu-box:11435/" })).toBe("http://gpu-box:11435");
  });
  test("ollama: missing port defaults to 11434, leading colon means localhost", () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: "gpu-box" })).toBe("http://gpu-box:11434");
    expect(ollamaBaseUrl({ OLLAMA_HOST: ":8080" })).toBe("http://localhost:8080");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "[::1]:11434" })).toBe("http://[::1]:11434");
  });
  test("ollama: a full URL is kept (scheme case-insensitive, slashes trimmed)", () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: "https://ollama.example.com/" })).toBe("https://ollama.example.com");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "HTTP://h:1" })).toBe("HTTP://h:1");
  });
});

describe("fetchTags reads OLLAMA_HOST at call time", () => {
  const saved = process.env["OLLAMA_HOST"];
  afterEach(() => {
    if (saved === undefined) delete process.env["OLLAMA_HOST"];
    else process.env["OLLAMA_HOST"] = saved;
  });
  const capture = () => {
    const urls: string[] = [];
    const fake = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { urls, fake };
  };
  test("default", async () => {
    delete process.env["OLLAMA_HOST"];
    const { urls, fake } = capture();
    await fetchTags(undefined, 1000, fake);
    expect(urls).toEqual(["http://localhost:11434/api/tags"]);
  });
  test("override", async () => {
    process.env["OLLAMA_HOST"] = "gpu-box:11435";
    const { urls, fake } = capture();
    await fetchTags(undefined, 1000, fake);
    expect(urls).toEqual(["http://gpu-box:11435/api/tags"]);
  });
});
