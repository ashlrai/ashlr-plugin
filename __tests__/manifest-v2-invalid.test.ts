import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestV2, upgradeManifest } from "../servers/_manifest-v2";

// Documented result: a malformed manifest is treated as missing (null), never thrown,
// and the bad file is left untouched on disk.

let cwd: string;
let file: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ashlr-manifest-v2-invalid-"));
  const dir = join(cwd, ".ashlrcode", "genome");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "manifest.json");
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const malformed: Array<[string, string]> = [
  ["empty file", ""],
  ["whitespace only", "   \n"],
  ["truncated JSON", '{"version":1,"sections":['],
  ["not JSON", "not a manifest"],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON string", '"manifest"'],
  ["JSON number", "42"],
  ["empty object", "{}"],
  ["v1 without sections", '{"version":1,"project":"x"}'],
  ["v2 without sections", '{"version":1,"schemaVersion":2}'],
  ["sections not an array", '{"version":1,"sections":"nope"}'],
  ["v2 sections not iterable", '{"version":1,"schemaVersion":2,"sections":{"a":1}}'],
  ["v2 section entry is null", '{"version":1,"schemaVersion":2,"sections":[null]}'],
];

describe("loadManifestV2 rejects malformed manifests", () => {
  for (const [name, raw] of malformed) {
    test(`${name} → null, file untouched`, async () => {
      writeFileSync(file, raw);
      expect(await loadManifestV2(cwd)).toBeNull();
      expect(readFileSync(file, "utf-8")).toBe(raw);
    });
  }

  test("v1 section entry that is null → null", async () => {
    writeFileSync(file, '{"version":1,"sections":[null]}');
    expect(await loadManifestV2(cwd)).toBeNull();
  });

  test("missing manifest → null", async () => {
    rmSync(file, { force: true });
    expect(await loadManifestV2(cwd)).toBeNull();
  });
});

describe("upgradeManifest on invalid input", () => {
  test("throws on a manifest without sections (loader converts this to null)", () => {
    expect(() => upgradeManifest({ version: 1 } as never)).toThrow();
    expect(() => upgradeManifest(null as never)).toThrow();
  });
});
