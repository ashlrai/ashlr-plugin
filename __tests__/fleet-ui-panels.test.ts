import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetPanels, startFleetUi } from "../scripts/fleet-ui-server";

const dir = join(import.meta.dir, "../scripts/fleet-ui"), panels = fleetPanels();
const source = (file: string) => readFileSync(join(dir, file), "utf8");
// Scripts a shell can load: <script src> and service-worker registration in its html, then static `from './x.js'` imports.
function reachable(shell: string) {
  const seen = new Set<string>();
  const stack = [...source(shell + ".html").matchAll(/(?:src=|register\()\s*["']\.?\/?([a-z0-9-]+\.js)["']/g)].map(([, file]) => file);
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, dep] of source(file).matchAll(/from ['"]\.\/([a-z0-9-]+\.js)['"]/g)) stack.push(dep);
  }
  return seen;
}
const shells: Record<string, Set<string>> = { index: reachable("index"), mobile: reachable("mobile") };

test("every manifest entry is a unique titled panel resolving to a shipped script", () => {
  expect(panels.length).toBeGreaterThan(0);
  expect(new Set(panels.map(panel => panel.id)).size).toBe(panels.length);
  expect(new Set(panels.map(panel => panel.script)).size).toBe(panels.length);
  for (const panel of panels) {
    expect(panel.id).toMatch(/^[a-z0-9-]+$/);
    expect(panel.title.length).toBeGreaterThan(0);
    // Basename-only script names keep the served paths incapable of traversal.
    expect(panel.script).toMatch(/^[a-z0-9-]+\.js$/);
    expect(existsSync(join(dir, panel.script))).toBe(true);
  }
});

test("declared lanes equal each shell's reachable scripts; nothing reachable is undeclared", () => {
  for (const panel of panels)
    expect([...panel.lanes].sort()).toEqual(Object.keys(shells).filter(shell => shells[shell].has(panel.script)).sort());
  for (const files of Object.values(shells))
    for (const file of files) expect(panels.some(panel => panel.script === file)).toBe(true);
  // The service worker's precache may only name mobile-lane panels.
  for (const [, file] of source("mobile-sw.js").matchAll(/'\/([a-z0-9-]+\.js)'/g))
    expect(panels.find(panel => panel.script === file)?.lanes).toContain("mobile");
});

test("server serves exactly the manifest scripts; unlisted and traversal paths 404", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-panels-"))), server = startFleetUi({ root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const panel of panels) {
      const response = await fetch(base + "/" + panel.script);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(await response.text()).toBe(source(panel.script));
    }
    // Shipped but undeclared scripts are embedded source modules and stay unserved.
    const unlisted = readdirSync(dir).filter(file => file.endsWith(".js") && !panels.some(panel => panel.script === file));
    expect(unlisted.sort()).toEqual(["map-filter.js", "mobile-alerts.js", "mobile-browser.js", "mobile-steer.js"]);
    for (const path of [...unlisted.map(file => "/" + file), "/panels.json", "/fleet-ui/panels.json", "/index.html",
      "/mobile.html", "/control-panel.d.ts", "/nonexistent.js", "/../package.json", "/..%2f..%2fpackage.json"])
      expect((await fetch(base + path)).status).toBe(404);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
