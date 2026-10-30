#!/usr/bin/env bun
/** bun scripts/fleet-spawn.ts TASK --repo owner/name [--author NAME] [--reason TEXT] [--root DIR] [--output steer-proposals.jsonl]
 * One command files an audited "spawn" proposal — a request that the fleet
 * take TASK as new work for --repo — on the same journal fleet-steer uses:
 * steer-proposals.jsonl under the fleet root, appended via the identical
 * link-resistant, audit-preserving path. Every call emits JSON.
 * The task queue (tasks.json), mirrors and every other fleet file stay
 * unwritable: proposals are suggestions for controller review, never queued
 * work. --repo must name an enrolled fleet mirror — the owner/name of a real
 * mirrors/<owner>__<name> directory, or the unique name half of one —
 * anything else is an unknown repo. An identical pending proposal is refused.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { appendFleetRecord } from "../servers/fleet-intent-server-handlers";
import { readJournal, TERMINAL_STATUSES } from "./fleet-journal";

const PROPOSALS = "steer-proposals.jsonl";
const PROTECTED = `Proposals may only append to ${PROPOSALS}; the task queue and fleet state files are protected`;
const usage = "Usage: fleet-spawn TASK --repo owner/name [--author NAME] [--reason TEXT] [--root DIR]" +
  " [--output " + PROPOSALS + "]";
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Owner segments never contain "_", so the first "__" in owner__name is unambiguous.
const MIRROR = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})__([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/;
// Control and bidi-override characters are refused outright, never silently kept.
const BAD_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
const MAX_TASK = 4_000;

/** Enrolled fleet repos: real mirrors/<owner>__<name> directories only — pin symlinks never enroll. */
function enrolled(root: string): Map<string, { owner: string; name: string; dir: string }> {
  const repos = new Map<string, { owner: string; name: string; dir: string }>();
  const dir = join(root, "mirrors");
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return repos;
    entries = readdirSync(dir);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return repos;
    throw error;
  }
  for (const entry of entries) {
    const match = MIRROR.exec(entry);
    try {
      if (match && lstatSync(join(dir, entry)).isDirectory()) {
        repos.set(entry.toLowerCase(), { owner: match[1]!, name: match[2]!, dir: entry });
      }
    } catch { /* entry vanished mid-scan */ }
  }
  return repos;
}

/** Resolve --repo to the enrolled owner/name: exact owner/name or a unique name-half match. */
function resolveRepo(root: string, value: string) {
  const repos = enrolled(root);
  const direct = REPO.test(value) ? repos.get(value.toLowerCase().replace("/", "__")) : undefined;
  const named = !direct && NAME.test(value)
    ? [...repos.values()].filter(repo => repo.name.toLowerCase() === value.toLowerCase()) : [];
  const repo = direct ?? (named.length === 1 ? named[0]! : undefined);
  if (repo === undefined) {
    if (named.length > 1) throw new Error(`ambiguous fleet repo: ${named.map(r => `${r.owner}/${r.name}`).sort((a, b) => a.localeCompare(b)).join(", ")}`);
    throw new Error("unknown fleet repo");
  }
  return repo;
}

/** Same-shape dedup key as fleet-steer: repo is case-insensitive, task text is not. */
const pendingKey = (p: Record<string, unknown>) =>
  typeof p.status === "string" && TERMINAL_STATUSES.has(p.status) ? null
    : JSON.stringify({
      action: p.action ?? null,
      repo: typeof p.repo === "string" ? p.repo.toLowerCase() : null,
      task: typeof p.task === "string" ? p.task.trim() : null,
    });

export function fleetSpawn(argv: string[], now = new Date(), root = join(homedir(), ".ashlr", "fleet")) {
  const [task, ...args] = argv;
  if (task === undefined || task.startsWith("--")) throw new Error(usage);
  const text = task.trim();
  if (!text || text.length > MAX_TASK || BAD_TEXT.test(text)) throw new Error(usage);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--repo", "--author", "--reason", "--root", "--output"].includes(key!) ||
        value === undefined || !value.trim() || options.has(key!)) throw new Error(usage);
    options.set(key!, value);
  }
  const repoArg = options.get("--repo");
  const author = (options.get("--author") ?? "fleet-spawn").trim(), reason = options.get("--reason")?.trim();
  if (repoArg === undefined || !author || author.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(author) ||
      (reason !== undefined && (!reason || reason.length > 512 || BAD_TEXT.test(reason)))) throw new Error(usage);
  const fleetRoot = resolve(options.get("--root") ?? root);
  const output = resolve(fleetRoot, options.get("--output") ?? PROPOSALS);
  // Only this fixed journal is writable, including when callers supply a path.
  if (basename(output).toUpperCase() !== PROPOSALS.toUpperCase() || output !== resolve(fleetRoot, PROPOSALS)) {
    throw new Error(PROTECTED);
  }
  const mirror = resolveRepo(fleetRoot, repoArg);
  const repo = `${mirror.owner}/${mirror.name}`;
  const key = pendingKey({ action: "spawn", repo, task: text });
  if (readJournal(output).entries.some(e => pendingKey(e.record) === key)) throw new Error("duplicate proposal");
  const proposal = {
    schema_version: 1, id: randomUUID(), proposed_at: now.toISOString(), author,
    action: "spawn", repo, task: text, ...(reason !== undefined ? { reason } : {}),
    observed: { mirror: mirror.dir }, status: "proposed",
  };
  appendFleetRecord(fleetRoot, PROPOSALS, proposal);
  return { command: "spawn" as const, output, proposal, bytesAppended: Buffer.byteLength(JSON.stringify(proposal) + "\n") };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(fleetSpawn(process.argv.slice(2))));
  } catch {
    console.error(JSON.stringify({ error: `Spawn command failed: check arguments, the enrolled repo name and file paths. Only ${PROPOSALS} is writable.`, usage }));
    process.exitCode = 1;
  }
}
