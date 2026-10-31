import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { FLEET_PORT_BASE, FLEET_PORT_SLOTS, fleetPortSlot, fleetUiPort } from "../scripts/fleet-port-slot";
import { startFleetUi } from "../scripts/fleet-ui-server";

const roots: string[] = [];
const servers: ReturnType<typeof startFleetUi>[] = [];
const fixture = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-slot-")));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the same worktree path always derives the same slot", () => {
  const worktree = fixture();
  const first = fleetPortSlot(worktree);
  expect(fleetPortSlot(worktree)).toEqual(first);
  expect(first.port).toBeGreaterThanOrEqual(FLEET_PORT_BASE);
  expect(first.port).toBeLessThanOrEqual(FLEET_PORT_BASE + 2 * (FLEET_PORT_SLOTS - 1));
  expect(first.port).toBeLessThan(65535); // Headroom for the share server's port + 1.
  expect(first.port % 2).toBe(0);
});

test("equivalent spellings of one path — dot segments, trailing slash, symlink — share a slot", () => {
  const worktree = fixture();
  const link = join(fixture(), "link");
  symlinkSync(worktree, link);
  for (const spelling of [join(worktree, "."), join(worktree, "sub", ".."), worktree + "/", link, join(dirname(worktree), basename(worktree))])
    expect(fleetPortSlot(spelling)).toEqual(fleetPortSlot(worktree));
});

test("distinct worktree paths derive distinct ports and data directories", () => {
  // Fixed nonexistent paths keep the port assertion deterministic.
  const a = fleetPortSlot("/nonexistent/fleet-slot-alpha"), b = fleetPortSlot("/nonexistent/fleet-slot-beta");
  expect(a.port).not.toBe(b.port);
  expect(a.dataDir).not.toBe(b.dataDir);
  const [one, two] = [fixture(), fixture()];
  expect(fleetPortSlot(one).dataDir).not.toBe(fleetPortSlot(two).dataDir);
  // Same basename under different parents still derives different data dirs via the hash suffix.
  for (const parent of [one, two]) mkdirSync(join(parent, "same"));
  expect(fleetPortSlot(join(one, "same")).dataDir).not.toBe(fleetPortSlot(join(two, "same")).dataDir);
});

test("the data directory is a stable slug under the given home", () => {
  const worktree = fixture(), home = fixture();
  const slot = fleetPortSlot(worktree, home);
  expect(dirname(slot.dataDir)).toBe(join(home, ".ashlr-worktrees"));
  expect(basename(slot.dataDir)).toMatch(new RegExp(`^${basename(worktree)}-[0-9a-f]{12}$`));
});

test("an explicit port always takes precedence over the derived slot", async () => {
  const worktree = fixture(), slot = fleetPortSlot(worktree);
  expect(fleetUiPort(undefined, worktree)).toBe(slot.port);
  expect(fleetUiPort(23456, worktree)).toBe(23456);
  expect(fleetUiPort(0, worktree)).toBe(0); // 0 stays explicit: the OS assigns a free port.
  const derived = startFleetUi({ worktree });
  servers.push(derived);
  expect(derived.port).toBe(slot.port);
  const probe = startFleetUi({ port: 0 });
  const free = probe.port ?? 0;
  await probe.stop(true);
  const explicit = startFleetUi({ worktree, port: free });
  servers.push(explicit);
  expect(explicit.port).toBe(free);
});

test("a missing worktree path still resolves to a slot", () => {
  const gone = join(fixture(), "removed");
  const slot = fleetPortSlot(gone);
  expect(fleetPortSlot(gone)).toEqual(slot);
  expect(basename(slot.dataDir)).toMatch(/^removed-[0-9a-f]{12}$/);
});
