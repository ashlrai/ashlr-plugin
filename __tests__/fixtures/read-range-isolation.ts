// Run in a separate Bun process so module mocks cannot affect other suites.
import { mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: Array<[number, number, string]> = [];
let forbidden = 0;
const denyIdentity = () => { forbidden++; throw new Error("identity/account probe called"); };
mock.module("../../servers/_identity-hash", () => ({
  getIdentityHash: denyIdentity, getOrCreateMachineId: denyIdentity,
  readGithubLoginFromCache: denyIdentity, quarterlySalt: denyIdentity,
}));
const actualStats = await import("../../servers/_stats");
mock.module("../../servers/_stats", () => ({ ...actualStats, recordSaving: async (...args: [number, number, string]) => { calls.push(args); } }));
mock.module("../../servers/_summarize", () => ({
  summarizeIfLarge: async () => { forbidden++; throw new Error("summarizer called"); },
  PROMPTS: { read: "" }, confidenceBadge: () => "", confidenceTier: () => "high", DEFAULT_THRESHOLD_BYTES: 1,
}));
mock.module("../../servers/_prefetch", () => ({ schedulePrefetch: () => { forbidden++; throw new Error("prefetch called"); } }));
mock.module("../../servers/_pro", () => ({ isProSync: () => { forbidden++; throw new Error("provider probe called"); } }));
mock.module("../../servers/_ast-skeleton", () => ({ renderAstSkeleton: () => { forbidden++; throw new Error("AST called"); } }));
globalThis.fetch = (() => { forbidden++; throw new Error("network called"); }) as unknown as typeof fetch;
const { ashlrRead } = await import("../../servers/read-server");
const dir = mkdtempSync(join(tmpdir(), "range-isolation-"));
const previousCwd = process.cwd();
try {
  process.chdir(dir);
  const source = Array.from({ length: 250 }, (_, i) => `é🙂 ${i}`).join("\n");
  writeFileSync("unicode.txt", source);
  const output = await ashlrRead({ path: "unicode.txt", startLine: 10, endLine: 12 });
  if (forbidden !== 0) throw new Error(`forbidden calls: ${forbidden}`);
  // Original ranges intentionally bypass savings accounting: calling the
  // shared writer would also trigger identity and daily-heartbeat work.
  if (calls.length !== 0) throw new Error(`range must not record savings: ${JSON.stringify(calls)}`);
  const expected = "unicode.txt L10-L12 of 250\n10: é🙂 9\n11: é🙂 10\n12: é🙂 11";
  if (output !== expected || Buffer.byteLength(source) !== 2639 || Buffer.byteLength(output) !== 67) {
    throw new Error("UTF-8 range bytes or original line numbering differ");
  }

} finally {
  // Windows cannot delete the process's current directory (EBUSY).
  try { process.chdir(previousCwd); } catch { /* the original cwd is already gone */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EBUSY" && code !== "EPERM" || attempt === 4) throw err;
    }
  }
}
