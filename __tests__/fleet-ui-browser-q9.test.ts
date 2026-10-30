import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFleetUi } from "../scripts/fleet-ui-server";
import { createSessionPanel, mountSessionPanel } from "../scripts/fleet-ui/session-panel.js";

let root: string, server: ReturnType<typeof startFleetUi>, base: string, dir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-browser-")));
  mkdirSync(join(root, "fleet"));
  for (const [file, data] of Object.entries({ "targets.json": "{}", "holds.json": "{}",
    "jobs.jsonl": '{"job_id":"RQ-1","pool":"codex","state":"running"}\n{"job_id":"RQ-2","pool":"codex","state":"queued"}\n', "leader-events.jsonl": "" }))
    writeFileSync(join(root, "fleet", file), data);
  dir = join(root, "fleet", "browser", "RQ-1");
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const n of [1, 2, 3]) writeFileSync(join(dir, `frames/${n}.png`), "png");
  writeFileSync(join(dir, "frames.jsonl"), [1, 2, 3].map(n => `{"path":"frames/${n}.png"}\n`).join(""));
  writeFileSync(join(dir, "current-url.txt"), "https://app.devin.ai/sessions/rq-1\n");
  server = startFleetUi({ root, port: 0 }); base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => { await server.stop(true); rmSync(root, { recursive: true, force: true }); });
const api = (path: string, init?: RequestInit) => fetch(base + path, init);
const node = (job: string) => ({ id: `job:${job}`, kind: "job", details: { job_id: job } });

test("GET /api/browser pages live frames by cursor and reports latest frame and current URL", async () => {
  const first = await api("/api/browser?job=RQ-1&limit=2");
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  const a = await first.json();
  expect(a).toMatchObject({ schema_version: 1, has_more: true,
    latest_frame_path: join(dir, "frames/3.png"), current_url: "https://app.devin.ai/sessions/rq-1" });
  expect(a.frames.map((frame: { index: number }) => frame.index)).toEqual([0, 1]);
  const b = await (await api("/api/browser?job=RQ-1&limit=2&cursor=" + encodeURIComponent(a.cursor))).json();
  expect(b.frames.map((frame: { index: number }) => frame.index)).toEqual([2]);
  expect(b.has_more).toBe(false);
  writeFileSync(join(dir, "frames/4.png"), "png");
  appendFileSync(join(dir, "frames.jsonl"), '{"path":"frames/4.png"}\n');
  const c = await (await api("/api/browser?job=RQ-1&cursor=" + encodeURIComponent(b.cursor))).json();
  expect(c.frames).toEqual([{ index: 3, path: join(dir, "frames/4.png") }]);
});

test("missing browser dirs, missing frames and unsafe artifacts fail closed", async () => {
  expect((await api("/api/browser?job=RQ-2")).status).toBe(404);
  writeFileSync(join(dir, "frames.jsonl"), '{"path":"frames/missing.png"}\n');
  expect((await api("/api/browser?job=RQ-1")).status).toBe(400);
  rmSync(join(dir, "frames.jsonl"));
  expect((await api("/api/browser?job=RQ-1")).status).toBe(400);
  const outside = join(root, "outside");
  mkdirSync(outside); writeFileSync(join(outside, "frames.jsonl"), '{"path":"frames/1.png"}\n');
  rmSync(dir, { recursive: true }); symlinkSync(outside, dir);
  expect((await api("/api/browser?job=RQ-1")).status).toBe(404);
});

test("rejects traversal, foreign cursors, bad limits, hostile hosts and methods", async () => {
  for (const job of ["../outside", "..%2foutside", "a/b", "RQ 1", "-x", "RQ-1.jsonl"])
    expect((await api("/api/browser?job=" + job)).status).toBe(400);
  expect((await api("/api/browser")).status).toBe(400);
  for (const limit of ["0", "201", "1.5", "x", "-1"])
    expect((await api("/api/browser?job=RQ-1&limit=" + limit)).status).toBe(400);
  const cursor = (await (await api("/api/browser?job=RQ-1&limit=2")).json()).cursor;
  for (const bad of ["bad", cursor.slice(0, -8), JSON.stringify({ ...JSON.parse(cursor), offset: -1 })])
    expect((await api("/api/browser?job=RQ-1&cursor=" + encodeURIComponent(bad))).status).toBe(400);
  const other = join(root, "fleet", "browser", "RQ-2");
  mkdirSync(other); writeFileSync(join(other, "frames.jsonl"), "");
  const foreign = (await (await api("/api/browser?job=RQ-2")).json()).cursor;
  expect((await api("/api/browser?job=RQ-1&cursor=" + encodeURIComponent(foreign))).status).toBe(400);
  expect((await api("/api/browser?job=RQ-1", { headers: { host: "attacker.example" } })).status).toBe(403);
  expect((await api("/api/browser?job=RQ-1", { headers: { origin: "https://attacker.example" } })).status).toBe(403);
  expect((await api("/api/browser?job=RQ-1", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await api("/api/browser?job=RQ-1", { method: "POST" })).status).toBe(405);
});

test("session panel surfaces live frames and URL only for nodes that have them", async () => {
  const paths: string[] = [], views: any[] = [];
  const panel = createSessionPanel(async (path: string) => {
    paths.push(path);
    const response = await api(path);
    if (!response.ok) throw Error("unavailable");
    return response.json();
  }, (view: unknown) => views.push(view));
  try {
    await panel.open(node("RQ-1")); panel.close();
    expect(views.at(-1).browser).toMatchObject({ url: "https://app.devin.ai/sessions/rq-1",
      latest: join(dir, "frames/3.png"), frames: [1, 2, 3].map(n => join(dir, `frames/${n}.png`)) });
    writeFileSync(join(dir, "frames/4.png"), "png");
    appendFileSync(join(dir, "frames.jsonl"), '{"path":"frames/4.png"}\n');
    await panel.open(node("RQ-1")); panel.close();
    expect(paths.filter(path => path.includes("/api/browser")).at(-1)).toContain("cursor=");
    expect(views.at(-1).browser.frames.at(-1)).toBe(join(dir, "frames/4.png"));
    await panel.open(node("RQ-2")); panel.close();
    expect(views.at(-1).browser).toBeNull();
    await panel.open({ id: "lane:codex", kind: "lane", details: { target: 2 } }); panel.close();
    expect(views.at(-1).browser).toBeNull();
    expect(paths.filter(path => path.includes("/api/browser")).length).toBe(3);
  } finally { panel.close(); }
});

test("mounted panel shows the browser section only when frames exist and links only http(s) URLs", async () => {
  const element = (): any => ({ textContent: "", hidden: false, children: [] as unknown[],
    replaceChildren(...children: unknown[]) { this.children = children; },
    removeAttribute(name: string) { this[name] = undefined; } });
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {} };
  const els: Record<string, any> = { "#session": dialog };
  for (const id of ["#session-title", "#session-state", "#session-log", "#session-links",
    "#session-browser", "#browser-url", "#browser-frames", "#close-session"]) els[id] = element();
  const doc = { querySelector: (selector: string) => els[selector], createElement: () => element() };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((path: string) => realFetch(base + String(path))) as typeof fetch;
  try {
    const panel = mountSessionPanel(doc as unknown as Document);
    await panel.open(node("RQ-1")); panel.close();
    expect(dialog.open).toBe(true);
    expect(els["#session-browser"].hidden).toBe(false);
    expect(els["#browser-url"].textContent).toBe("Current URL: https://app.devin.ai/sessions/rq-1");
    expect(els["#browser-url"].href).toBe("https://app.devin.ai/sessions/rq-1");
    expect(els["#browser-frames"].textContent).toContain(join(dir, "frames/3.png"));
    writeFileSync(join(dir, "current-url.txt"), "javascript:alert(1)\n");
    await panel.open(node("RQ-1")); panel.close();
    expect(els["#browser-url"].textContent).toBe("Current URL: javascript:alert(1)");
    expect(els["#browser-url"].href).toBeUndefined();
    await panel.open(node("RQ-2")); panel.close();
    expect(els["#session-browser"].hidden).toBe(true);
    const empty = join(root, "fleet", "browser", "RQ-2");
    mkdirSync(empty); writeFileSync(join(empty, "frames.jsonl"), "");
    await panel.open(node("RQ-2")); panel.close();
    expect(els["#session-browser"].hidden).toBe(true);
    writeFileSync(join(empty, "current-url.txt"), "https://chatgpt.com/codex/rq-2\n");
    await panel.open(node("RQ-2")); panel.close();
    expect(els["#session-browser"].hidden).toBe(false);
    expect(els["#browser-url"].href).toBe("https://chatgpt.com/codex/rq-2");
    expect(els["#browser-frames"].textContent).toBe("");
    expect(await (await realFetch(base + "/")).text()).toContain('id="session-browser"');
  } finally { globalThis.fetch = realFetch; }
});
