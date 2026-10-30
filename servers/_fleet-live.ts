/** _fleet-live.ts — the router queue's job split: live, ghost and held.
 *
 * fleetSource's static files record what the queue was told; queue/run/ says
 * what is actually executing. It holds per-job artifacts in the shape
 * scripts/fleet-ghosts.ts reads (<lane>/<job>.{base,log,log.gz,pid}, with
 * root-level job files reporting under the "." lane) plus <job>.phdrip
 * markers — each phdrip file is one job the router is holding out of
 * dispatch, and the held bucket is exactly the phdrip count. The split:
 *   live   — job names the process checks verified running;
 *   ghosts — job names fleet-ghosts reports as abandoned worktrees;
 *   held   — stems of every *.phdrip marker in queue/run/ and its lanes.
 * The three lists are independent evidence, not a partition: a stale marker
 * left beside a genuinely running job appears in both. Names are qualified
 * "lane/job" ("." lane jobs stay unqualified) so lanes cannot collide.
 * A missing or linked queue/run/ is an empty split, never an error and never
 * a process-table spawn; a present but unreadable one reports its error.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanRunsJobs, type GhostDeps } from "../scripts/fleet-ghosts";

export const RUN_DIR = join("queue", "run");
/** Stable error key for the run dir; RUN_DIR itself is platform-joined. */
const RUN_KEY = "queue/run";
const HELD = ".phdrip";

export interface FleetLive {
  live: string[];
  ghosts: string[];
  held: string[];
  /** false when the process table was unavailable or the run dir unreadable. */
  live_known: boolean;
  counts: { live: number; ghosts: number; held: number };
  errors: Record<string, string>;
}

const empty = (): FleetLive =>
  ({ live: [], ghosts: [], held: [], live_known: true, counts: { live: 0, ghosts: 0, held: 0 }, errors: {} });

const qualify = (lane: string, name: string) => lane === "." ? name : `${lane}/${name}`;
const marker = (name: string): string | null =>
  name.endsWith(HELD) && name.length > HELD.length ? name.slice(0, -HELD.length) : null;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unavailable";

/** Held-marker stems directly inside dir, qualified by lane; links and dirs are not markers. */
function heldIn(dir: string, lane: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isFile()) {
      const stem = marker(entry.name);
      if (stem !== null) out.push(qualify(lane, stem));
    }
}

export function fleetLive(root: string, deps: GhostDeps = {}): FleetLive {
  const run = join(resolve(root), RUN_DIR);
  // lstat rejects links and non-directories: a runs dir we cannot trust is
  // absent; a stat failure other than "not there" is a reported error.
  try { if (!lstatSync(run).isDirectory()) return empty(); }
  catch (error) {
    const errno = code(error);
    if (errno === "ENOENT" || errno === "ENOTDIR") return empty();
    const failed = empty();
    failed.live_known = false;
    failed.errors[RUN_KEY] = errno;
    return failed;
  }
  const errors: Record<string, string> = {};
  const live: string[] = [], ghosts: string[] = [], held: string[] = [];
  let live_known = true;
  try {
    const scan = scanRunsJobs(run, deps);
    live_known = scan.live_known;
    Object.assign(errors, scan.errors);
    for (const { lane, jobs } of scan.lanes)
      for (const job of jobs) {
        if (job.live === true) live.push(qualify(lane, job.name));
        if (job.ghost) ghosts.push(qualify(lane, job.name));
      }
  } catch (error) {
    live_known = false;
    errors[RUN_KEY] = code(error);
  }
  try {
    for (const entry of readdirSync(run, { withFileTypes: true })) {
      if (entry.isFile()) {
        const stem = marker(entry.name);
        if (stem !== null) held.push(stem);
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        heldIn(join(run, entry.name), entry.name, held);
      }
    }
  } catch (error) { errors[RUN_KEY] = code(error); }
  for (const list of [live, ghosts, held]) list.sort((a, b) => a.localeCompare(b));
  return { live, ghosts, held, live_known,
    counts: { live: live.length, ghosts: ghosts.length, held: held.length }, errors };
}
