/**
 * _pid-alive.ts — "is this PID still a running process?"
 *
 * `process.kill(pid, 0)` succeeds for a zombie: a process that has exited but
 * whose parent has not reaped it. Containers whose PID 1 is not an init that
 * reaps orphans (common for agent sandboxes) keep every orphaned exit as a
 * zombie, so a kill-only check reports long-dead background jobs and lock
 * owners as alive forever. On Linux, read the state letter from
 * /proc/<pid>/stat and treat Z (zombie) and X (dead) as gone.
 */

import { readFileSync } from "fs";

/**
 * True when `pid` names a live, non-zombie process. EPERM (the process exists
 * but belongs to another user) counts as alive.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return !isLinuxZombie(pid);
}

function isLinuxZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Format: "pid (comm) S ...". comm may contain spaces or parentheses, so
    // the state is the first field after the last ")".
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state === "Z" || state === "X";
  } catch {
    // /proc unreadable (hidepid, exotic mounts): fall back to the kill result.
    return false;
  }
}
