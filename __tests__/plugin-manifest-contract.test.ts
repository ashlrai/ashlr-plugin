import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readPhantomPluginManifest } from "./contract/phantom-plugin-manifest.ts";

const fixture = (name: string) => readFileSync(
  new URL(`./fixtures/plugin-manifest/${name}.json`, import.meta.url), "utf8",
);

describe("Phantom Claude plugin cache manifest contract", () => {
  test("the shipped Claude manifest exposes the package identity and version", () => {
    const raw = readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(readPhantomPluginManifest(raw, "0.0.0")).toEqual({ version: pkg.version });
    expect(JSON.parse(raw).name).toBe("ashlr");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("minimal manifest is recognized and takes precedence over the cache directory", () => {
    expect(readPhantomPluginManifest(fixture("valid"), "9.9.9")).toEqual({ version: "1.2.3" });
  });

  test("extra metadata is ignored without interpreting MCP commands", () => {
    expect(readPhantomPluginManifest(fixture("extra-fields"), "9.9.9"))
      .toEqual(readPhantomPluginManifest(fixture("valid"), "9.9.9"));
  });

  test("missing identity cannot be inferred from a cache directory", () => {
    expect(readPhantomPluginManifest(fixture("missing-name"), "1.2.3")).toBeNull();
  });

  test.each(["other-plugin", "Ashlr", "", null, 42, ["ashlr"]].map((name) => [name] as const))(
    "rejects an invalid plugin identity: %j", (name) => {
      expect(readPhantomPluginManifest(JSON.stringify({ name, version: "1.2.3" }), "1.2.3")).toBeNull();
    },
  );

  test.each(["1.2.3", "v1.2.3", "1.2.3-beta.1", "1.2.3+build.4"])(
    "missing version falls back to directory %s", (directory) => {
      expect(readPhantomPluginManifest(fixture("missing-version"), directory))
        .toEqual({ version: directory.replace(/^v/, "") });
    },
  );

  test.each([null, 123, {}, []].map((version) => [version] as const))("non-string version %j uses the directory", (version) => {
    expect(readPhantomPluginManifest(JSON.stringify({ name: "ashlr", version }), "v2.3.4"))
      .toEqual({ version: "2.3.4" });
  });

  test("missing version and unusable directory retain an unknown version", () => {
    expect(readPhantomPluginManifest(fixture("missing-version"), "unknown"))
      .toEqual({ version: null });
  });

  test.each(["{", "", "null", "[]", "42", '"ashlr"'])(
    "malformed or non-object JSON is ignored: %j", (raw) => {
      expect(readPhantomPluginManifest(raw, "1.2.3")).toBeNull();
    },
  );
});
