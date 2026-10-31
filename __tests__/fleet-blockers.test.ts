import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOAUTHOR_STALE_S, fleetBlockers } from "../scripts/fleet-blockers";
import type { GhostDeps } from "../scripts/fleet-ghosts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DEAD: GhostDeps = { procs: () => [], alive: () => false, now: () => NOW };

let home: string, runs: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "fleet-blockers-")));
  runs = join(home, ".ashlr-runs");
  mkdirSync(join(runs, "queue", "run"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const w = (name: string, text: string | Buffer) => writeFileSync(join(runs, name), text);
const snapshotTree = (dir: string): Record<string, string> => Object.fromEntries(
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map(name => {
    const stat = lstatSync(join(dir, name));
    return [name, stat.isFile() ? readFileSync(join(dir, name), "utf8") : `mode:${stat.mode & 0o777}`] as const;
  }));

/** A queue/run job: any of ".base" (dir), ".log", ".log.gz", ".pid", ".phdrip". */
const runJob = (lane: string, name: string, parts: string[]) => {
  const dir = join(runs, "queue", "run", ...(lane === "." ? [] : [lane]));
  mkdirSync(dir, { recursive: true });
  for (const part of parts) {
    if (part === ".base") mkdirSync(join(dir, name + part));
    else writeFileSync(join(dir, name + part), part === ".pid" ? "4242\n" : "");
  }
};
const row = (state: string, lane = "dev", id = `RQ-${state}`) => `- ${state} ${id} (pool=${lane}, tier=work, repo=phantom): detail`;
const aliveDeps: GhostDeps = { procs: () => [], alive: pid => pid === 4242, now: () => NOW };

/** Every source present and readable; callers adjust individual files. */
function fixture() {
  w("queue/slots.json", JSON.stringify({ dev: 3, ops: { target: 2 } }));
  w("metrics/jobs.jsonl", '{"job_id":"RQ-9","pool":"dev","state":"running"}\n');
  w("queue/dispatch-events.log", '[2026-10-30T11:00:00Z] dispatched job=RQ-9\n');
  w("router-events.log", `[${new Date(NOW - 60_000).toISOString()}] AUTOAUTHOR done\n`);
  w("queue-author-codex.log", "INFO done\n");
  w("ROUTER-QUEUE.md", "# Queue\n\n" + [row("READY", "dev", "RQ-A"), row("CLAIMED", "ops", "RQ-B")].join("\n") + "\n");
}

test("live workers versus targets drive per-lane deficits and restock need versus picked", () => {
  fixture();
  runJob("dev", "j1", [".base", ".log", ".pid"]); // live via alive pid
  const result = fleetBlockers(runs, aliveDeps);
  expect(result.lanes.dev).toMatchObject({ target: 3, live: 1, deficit: 2, ready: 1, picked: 0, need: 1 });
  expect(result.lanes.ops).toMatchObject({ target: 2, live: 0, deficit: 2, ready: 0, picked: 1, need: 1 });
  expect(result.totals).toMatchObject({ target: 5, live: 1, demand: 4, held_demand: 0 });
  expect(result.restock).toMatchObject({ need: 2, ready: 1, picked: 1 });
  expect(result.restock.by_status).toEqual({ READY: 1, CLAIMED: 1 });
  expect(result.verdict).toBe("idle");
  expect(result.idle).toBe(true);
  expect(result.blockers).toEqual(["shortfall:dev", "shortfall:ops", "queue_short"]);
  expect(result.errors).toEqual({});
  expect(result.sources["queue/slots.json"]).toBe("ok");
});

test("queued supply covering every deficit keeps the verdict working", () => {
  fixture();
  runJob("dev", "j1", [".base", ".log", ".pid"]);
  // dev needs 2 more: 1 READY row already pooled there, add one CLAIMED too.
  w("ROUTER-QUEUE.md", [row("READY", "dev", "RQ-A"), row("CLAIMED", "dev", "RQ-C"),
    row("READY", "ops", "RQ-D"), row("CLAIMED", "ops", "RQ-B"), row("CLAIMED", "ops", "RQ-E")].join("\n"));
  const result = fleetBlockers(runs, aliveDeps);
  expect(result.restock.need).toBe(0);
  expect(result.verdict).toBe("working");
  expect(result.idle).toBe(false);
  expect(result.blockers).toEqual([]);
  // Claimed supply in excess of demand still reads working, not idle.
  expect(result.lanes.ops?.picked).toBe(2);
});

test("HOLD lanes carry their own deficit: text, per-lane JSON and wildcard forms", () => {
  fixture();
  w("HOLD", '{"ops":"quota pause"}');
  const held = fleetBlockers(runs, aliveDeps);
  expect(held.lanes.ops).toMatchObject({ held: "quota pause", deficit: 2, picked: 1, need: 1 });
  expect(held.totals.held_demand).toBe(2);
  expect(held.blockers).toContain("held_lane:ops");
  // dev still has unmet demand, so the fleet is idle rather than held.
  expect(held.verdict).toBe("idle");

  // Every lane held and nothing else unmet: the fleet is held, not idle.
  rmSync(join(runs, "HOLD"));
  w("queue/slots.json", JSON.stringify({ ops: 1 }));
  w("HOLD", "maintenance window\n");
  w("ROUTER-QUEUE.md", "");
  const all = fleetBlockers(runs, aliveDeps);
  expect(all.lanes.ops?.held).toBe("maintenance window");
  expect(all.verdict).toBe("held");
  expect(all.blockers).toEqual(["held_lane:ops"]);

  // Lane-list HOLD and a slot-level held flag mark lanes the same way.
  w("HOLD", '["ops"]');
  expect(fleetBlockers(runs, aliveDeps).lanes.ops?.held).toBe("held");
  w("queue/slots.json", JSON.stringify({ ops: { target: 1, held: true } }));
  rmSync(join(runs, "HOLD"));
  expect(fleetBlockers(runs, aliveDeps).lanes.ops?.held).toBe("held");
});

test("ghost worktrees and phdrip-held jobs are blockers without forcing idle", () => {
  fixture();
  w("queue/slots.json", JSON.stringify({ dev: 1 }));
  runJob("dev", "w1", [".base", ".log", ".pid"]);      // live
  runJob("dev", "g1", [".base", ".log.gz"]);          // ghost: archived, no log, dead
  runJob("dev", "h1", [".phdrip"]);                   // held out of dispatch
  const result = fleetBlockers(runs, aliveDeps);
  expect(result.verdict).toBe("working");
  expect(result.lanes.dev).toMatchObject({ live: 1, deficit: 0, ghosts: 1, held_jobs: 1 });
  expect(result.blockers).toEqual(["ghosts:dev", "held_jobs:dev"]);
  expect(result.totals).toMatchObject({ ghosts: 1, held_jobs: 1, ghost_jobs: ["dev/g1"], held_job_ids: ["dev/h1"] });
});

test("restock need versus picked: empty, short and unreadable queues", () => {
  fixture();
  w("queue/slots.json", JSON.stringify({ dev: 2 }));
  w("ROUTER-QUEUE.md", "- DONE RQ-old (pool=dev): finished\nfreeform note\n");
  const empty = fleetBlockers(runs, DEAD);
  expect(empty.restock).toMatchObject({ need: 2, ready: 0, picked: 0 });
  expect(empty.blockers).toContain("queue_empty");

  w("ROUTER-QUEUE.md", row("CLAIMED", "dev", "RQ-B") + '\n{"status":"READY","id":"RQ-J","repo":"ashlrai/phantom"}\n');
  const short = fleetBlockers(runs, DEAD);
  // The JSONL READY row counts in by_status but has no pool lane to cover.
  expect(short.restock).toMatchObject({ need: 1, ready: 1, picked: 1 });
  expect(short.restock.by_status).toEqual({ READY: 1, CLAIMED: 1 });
  expect(short.blockers).toContain("queue_short");

  rmSync(join(runs, "ROUTER-QUEUE.md"));
  const unreadable = fleetBlockers(runs, DEAD);
  expect(unreadable.restock).toEqual({ need: 2, ready: null, picked: null, by_status: null });
  expect(unreadable.blockers).toContain("queue_unreadable");
  expect(unreadable.queue.status).toBe("unknown");
});

test("AUTOAUTHOR age gates stale, silent and unknown blockers", () => {
  fixture();
  w("queue/slots.json", JSON.stringify({ dev: 1 }));
  w("ROUTER-QUEUE.md", "");
  const fresh = fleetBlockers(runs, DEAD);
  expect(fresh.autoauthor).toMatchObject({ age_s: 60, stale: false, last_error: null });
  expect(fresh.blockers).not.toContain("autoauthor_stale");

  w("router-events.log", `[${new Date(NOW - (AUTOAUTHOR_STALE_S + 1) * 1000).toISOString()}] AUTOAUTHOR done\n`);
  const stale = fleetBlockers(runs, DEAD);
  expect(stale.autoauthor.age_s).toBe(AUTOAUTHOR_STALE_S + 1);
  expect(stale.autoauthor.stale).toBe(true);
  expect(stale.blockers).toContain("autoauthor_stale");

  w("router-events.log", "[2026-10-30T10:00:00Z] dispatched job=RQ-1\n");
  expect(fleetBlockers(runs, DEAD).blockers).toContain("autoauthor_silent");

  rmSync(join(runs, "router-events.log"));
  const gone = fleetBlockers(runs, DEAD);
  expect(gone.blockers).toContain("autoauthor_unknown");
  expect(gone.errors["router-events.log"]).toBe("missing");

  // A fresh beat only blocks restock while unmet demand exists.
  fixture();
  const fed = fleetBlockers(runs, DEAD);
  expect(fed.blockers).not.toContain("autoauthor_stale");
});

test("truncated UTF-8 queue lines on READY/CLAIMED rows flag queue_split_utf8", () => {
  fixture();
  // "- " is 2 bytes, so a 157-char pad lands the curly quote's lead byte at 159.
  const pad = (state: string, start: number) => `${state} `.padEnd(start, "x") + "“" + " end";
  w("ROUTER-QUEUE.md", `- ${pad("READY", 157)}\n${row("CLAIMED", "ops", "RQ-B")}\n`);
  const split = fleetBlockers(runs, DEAD);
  expect(split.queue.status).toBe("split_utf8");
  expect(split.queue.split_lines).toEqual([{ line: 1, lines_from_tail: 1 }]);
  expect(split.blockers).toContain("queue_split_utf8");
  // The truncated row still parses as a READY status row for the inventory.
  expect(split.queue.rows).toBe(2);

  w("ROUTER-QUEUE.md", Buffer.from([0xff]));
  const bad = fleetBlockers(runs, DEAD);
  expect(bad.queue.status).toBe("unknown");
  expect(bad.errors["ROUTER-QUEUE.md"]).toBe("invalid_utf8");
  expect(bad.restock.by_status).toBeNull();
});

test("unknown verdicts: missing tree and an unavailable process table", () => {
  rmSync(runs, { recursive: true });
  const missing = fleetBlockers(runs, DEAD);
  expect(missing.verdict).toBe("unknown");
  expect(missing.lanes).toEqual({});
  expect(missing.restock).toEqual({ need: null, ready: null, picked: null, by_status: null });
  expect(missing.blockers).toEqual(["sources_degraded"]);
  expect(missing.sources).toMatchObject({
    "queue/slots.json": "missing", "HOLD": "missing", "queue/run": "absent",
    "router-events.log": "missing", "ROUTER-QUEUE.md": "missing",
  });

  mkdirSync(join(runs, "queue", "run"), { recursive: true });
  mkdirSync(join(runs, "metrics"), { recursive: true });
  fixture();
  const blind = fleetBlockers(runs, { procs: () => { throw new Error("no ps"); }, alive: () => false, now: () => NOW });
  expect(blind.live_known).toBe(false);
  expect(blind.verdict).toBe("unknown");
  expect(blind.lanes.dev?.deficit).toBeNull();
  expect(blind.restock.need).toBeNull();
  expect(blind.blockers[0]).toBe("live_unknown");
});

test("linked and hard-linked sources fail closed without echoing contents", () => {
  fixture();
  rmSync(join(runs, "ROUTER-QUEUE.md"));
  symlinkSync(join(runs, "metrics", "jobs.jsonl"), join(runs, "ROUTER-QUEUE.md"));
  const linked = fleetBlockers(runs, DEAD);
  expect(linked.errors["ROUTER-QUEUE.md"]).toBe("unsafe");
  expect(linked.queue.status).toBe("unknown");
  expect(JSON.stringify(linked)).not.toContain("RQ-9");

  rmSync(join(runs, "queue", "slots.json"));
  linkSync(join(runs, "metrics", "jobs.jsonl"), join(runs, "queue", "slots.json"));
  expect(fleetBlockers(runs, DEAD).verdict).toBe("unknown");
});

test("read-only: fixture bytes are identical after every read", () => {
  fixture();
  runJob("dev", "j1", [".base", ".log", ".pid"]);
  const before = snapshotTree(home);
  fleetBlockers(runs, aliveDeps);
  fleetBlockers(join(home, ".ashlr-runs"), DEAD);
  expect(snapshotTree(home)).toEqual(before);
});

const run = (args: string[] = []) => Bun.spawnSync(
  [process.execPath, join(import.meta.dir, "../scripts/fleet-blockers.ts"), ...args],
  { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });

test("CLI defaults to $HOME/.ashlr-runs, takes a root argument and stays read-only", () => {
  fixture();
  runJob("dev", "j1", [".base", ".log", ".pid"]);
  const before = snapshotTree(home);
  // queue/run exists, so a real `ps` scan runs inside the spawned process.
  const result = run();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report.runs).toBe(join(home, ".ashlr-runs"));
  expect(report.lanes.dev?.target).toBe(3);
  expect(report.sources["ROUTER-QUEUE.md"]).toBe("ok");
  expect(snapshotTree(home)).toEqual(before);

  const explicit = run([runs]);
  expect(explicit.exitCode).toBe(0);
  expect(JSON.parse(explicit.stdout.toString()).verdict).toBe("idle");
});

test("CLI exits nonzero on degraded evidence and rejects bad arguments", () => {
  // An empty tree still prints the verdict but exits 1 on missing sources.
  const degraded = run();
  expect(degraded.exitCode).toBe(1);
  expect(JSON.parse(degraded.stdout.toString()).verdict).toBe("unknown");
  for (const args of [["a", "b"], ["--root", "x"], ["--help"]]) {
    const result = run(args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("usage: bun scripts/fleet-blockers.ts");
  }
});
