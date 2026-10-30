import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetBrowserView } from "../scripts/fleet-browser-view.ts";

let root: string, job: string;
const index = (...paths: string[]) => writeFileSync(join(job, "frames.jsonl"), paths.map(path => JSON.stringify({ path }) + "\n").join(""));
const view = (args = {}) => fleetBrowserView(job, args);
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browser-view-"))); job = join(root, "job");
  mkdirSync(join(job, "frames"), { recursive: true });
  for (const n of [1, 2, 3]) writeFileSync(join(job, `frames/${n}.png`), "fixture");
  index("frames/1.png", "frames/2.png", "frames/3.png");
  writeFileSync(join(job, "current-url.txt"), "https://example.test/now\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("pages without duplicates; latest and URL are independent of page; supports append polling", () => {
  const a = view({ limit: 2 }), b = view({ limit: 2, cursor: a.cursor });
  expect(a).toMatchObject({ schema_version: 1, latest_frame_path: join(job, "frames/3.png"), current_url: "https://example.test/now", has_more: true });
  expect([...a.frames, ...b.frames].map(f => f.index)).toEqual([0, 1, 2]);
  expect(b.has_more).toBe(false); expect(view({ cursor: b.cursor }).frames).toEqual([]);
  appendFileSync(join(job, "frames.jsonl"), '{"path":"frames/1.png"}\n');
  expect(view({ cursor: b.cursor }).frames).toEqual([{ index: 3, path: join(job, "frames/1.png") }]);
});
test("empty index and missing URL are explicit; ignores unfinished append", () => {
  index(); rmSync(join(job, "current-url.txt"));
  appendFileSync(join(job, "frames.jsonl"), '{"path":');
  expect(view()).toMatchObject({ latest_frame_path: null, current_url: null, frames: [], has_more: false });
});
test("rejects malformed, foreign, truncated and rewritten cursors", () => {
  const cursor = view().cursor;
  for (const c of ["", "null", "{}", "../other", JSON.stringify({ ...JSON.parse(cursor), offset: -1 }), JSON.stringify({ ...JSON.parse(cursor), scope: "foreign" })]) expect(() => view({ cursor: c })).toThrow("cursor");
  writeFileSync(join(root, "frames.jsonl"), ""); index();
  expect(() => fleetBrowserView(root, { cursor: view().cursor })).toThrow("cursor");
  index("frames/1.png"); expect(() => view({ cursor })).toThrow("cursor");
  index("frames/3.png", "frames/2.png", "frames/1.png"); expect(() => view({ cursor })).toThrow("cursor");
});
test("maximum page size is bounded even with more available frames", () => {
  index(...Array(201).fill("frames/1.png"));
  const page = view({ limit: 200 }); expect(page.frames).toHaveLength(200); expect(page.has_more).toBe(true);
  expect(view({ cursor: page.cursor }).frames).toHaveLength(1);
});
test("rejects traversal, absolute paths, Windows paths and missing screenshots", () => {
  writeFileSync(join(root, "outside.png"), "outside");
  for (const path of ["../outside.png", "frames/../../outside.png", join(root, "outside.png"), "C:\\outside.png", "frames\\1.png", "frames/missing.png"]) {
    index(path); expect(() => view()).toThrow();
  }
});
test("rejects file/directory symlinks, hardlinks and linked metadata", () => {
  symlinkSync(join(job, "frames/1.png"), join(job, "link.png")); index("link.png"); expect(() => view()).toThrow("unsafe");
  symlinkSync(root, join(job, "escape")); index("escape/job/frames/1.png"); expect(() => view()).toThrow("unsafe");
  linkSync(join(job, "frames/2.png"), join(job, "hard.png")); index("hard.png"); expect(() => view()).toThrow("unsafe");
  index(); rmSync(join(job, "current-url.txt")); symlinkSync(join(job, "frames/1.png"), join(job, "current-url.txt")); expect(() => view()).toThrow("URL");
  rmSync(join(job, "frames.jsonl")); symlinkSync(join(job, "current-url.txt"), join(job, "frames.jsonl")); expect(() => view()).toThrow("unsafe");
});
test("rejects invalid limits, malformed/oversized index and invalid URL", () => {
  for (const limit of [0, -1, 201, 1.5, NaN]) expect(() => view({ limit })).toThrow("limit");
  writeFileSync(join(job, "current-url.txt"), "not a URL"); expect(() => view()).toThrow("URL");
  for (const text of ["null\n", "{broken}\n", "x".repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(join(job, "frames.jsonl"), text); expect(() => view()).toThrow();
  }
});
test("CLI emits JSON, pages, and fails safely with nonzero exit", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-browser-view.ts"), ...args], { env: { HOME: root } });
  const a = run(job, "--limit", "2"); expect(a.exitCode).toBe(0);
  const b = run(job, "--cursor", JSON.parse(a.stdout.toString()).cursor); expect(b.exitCode).toBe(0);
  expect(JSON.parse(b.stdout.toString()).frames.map((f: { index: number }) => f.index)).toEqual([2]);
  for (const args of [[], [job, "--limit", "0"], [job, "--wat", "x"], [job, "--cursor", "../bad"]]) {
    const result = run(...args); expect(result.exitCode).toBe(1); expect(result.stdout.length).toBe(0); expect(JSON.parse(result.stderr.toString()).error).toBeString();
  }
});
