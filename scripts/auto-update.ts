/**
 * Auto-update notifier for ashlr-plugin.
 *
 * Called at the end of session-start.ts. Fire-and-forget: never throws,
 * never blocks, never prints more than one line per day per version.
 *
 * Gate: writes a stamp to ~/.ashlr/last-update-notice containing
 * "<date>/<version>" so we notify at most once per calendar day per
 * upstream version.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

/** Parse a semver string into [major, minor, patch] integers. Returns null on parse failure. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

/**
 * Returns true if `upstream` is strictly newer than `current`.
 * Both must be valid semver strings; returns false if either fails to parse.
 */
export function isNewerVersion(current: string, upstream: string): boolean {
  const c = parseSemver(current);
  const u = parseSemver(upstream);
  if (!c || !u) return false;
  if (u[0] !== c[0]) return u[0] > c[0];
  if (u[1] !== c[1]) return u[1] > c[1];
  return u[2] > c[2];
}

// ---------------------------------------------------------------------------
// Stamp helpers
// ---------------------------------------------------------------------------

/** Current UTC date as `YYYY-MM-DD` — the canonical stamp-date format. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function updateNoticePath(home: string = homedir()): string {
  return join(home, ".ashlr", "last-update-notice");
}

/** Returns the stamp content: "<YYYY-MM-DD>/<version>" */
export function readUpdateStamp(home: string = homedir()): string {
  try {
    const p = updateNoticePath(home);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf-8").trim();
  } catch {
    return "";
  }
}

export function writeUpdateStamp(
  version: string,
  home: string = homedir(),
  today: string = todayISO(),
): void {
  try {
    const p = updateNoticePath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${today}/${version}`);
  } catch {
    /* never throw from a hook helper */
  }
}

/**
 * Returns true if we have already notified about this version today.
 * Parses stamp format: "<YYYY-MM-DD>/<version>".
 */
export function alreadyNotifiedToday(
  version: string,
  home: string = homedir(),
  today: string = todayISO(),
): boolean {
  const stamp = readUpdateStamp(home);
  if (!stamp) return false;
  const [date, ver] = stamp.split("/");
  return date === today && ver === version;
}

// ---------------------------------------------------------------------------
// GitHub API fetch
// ---------------------------------------------------------------------------

export interface GitHubRelease {
  tag_name: string;
}

/**
 * Fetch the latest release from GitHub with a 2-second timeout.
 * Returns null on any error (network, timeout, malformed JSON).
 */
export async function fetchLatestRelease(
  repo = "ashlrai/ashlr-plugin",
): Promise<GitHubRelease | null> {
  try {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "ashlr-plugin" },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (typeof json !== "object" || json === null) return null;
      if (typeof (json as Record<string, unknown>)["tag_name"] !== "string") return null;
      return json as GitHubRelease;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Check for updates and emit a one-line stderr notice if a newer version is
 * available and we haven't notified about it today.
 *
 * Never throws. Never blocks (call without await or use fire-and-forget).
 */
export async function checkForUpdate(opts: {
  currentVersion: string;
  home?: string;
  today?: string;
  repo?: string;
  /** Override fetch for tests */
  fetchFn?: (repo: string) => Promise<GitHubRelease | null>;
  /** Override stderr for tests */
  logger?: (msg: string) => void;
} = { currentVersion: "" }): Promise<void> {
  try {
    const {
      currentVersion,
      home = homedir(),
      today = todayISO(),
      repo = "ashlrai/ashlr-plugin",
      fetchFn = fetchLatestRelease,
      logger = (m) => process.stderr.write(m),
    } = opts;

    if (!currentVersion) return;

    const release = await fetchFn(repo);
    if (!release) return;

    const upstreamVersion = release.tag_name.replace(/^v/, "");
    if (!isNewerVersion(currentVersion, upstreamVersion)) return;
    if (alreadyNotifiedToday(upstreamVersion, home, today)) return;

    writeUpdateStamp(upstreamVersion, home, today);
    logger(
      `[ashlr] v${upstreamVersion} available (you're on v${currentVersion}). ` +
        `Run /ashlr-update to upgrade.\n`,
    );
  } catch {
    /* fire-and-forget: never surface errors */
  }
}
