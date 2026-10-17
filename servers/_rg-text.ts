/**
 * _rg-text.ts — the ripgrep fallback for ashlr__grep, as plain text.
 *
 * The fallback used to run `rg --json` and cut the JSON stream to its first
 * 2000 and last 1000 characters. JSON event lines are roughly three times the
 * size of `path:line:text`, so the cut kept only a handful of matches (often
 * as a half-open JSON object), and savings were counted against the JSON size
 * rather than what a plain grep would have returned.
 *
 * Here ripgrep prints `path:line:text`; if that exceeds the budget, whole
 * lines are kept from the head and tail and the omitted count is stated.
 */

/** ripgrep arguments for compact `path:line:text` output. */
export function rgTextArgs(pattern: string, searchRoot: string): string[] {
  return [
    "-n",
    "--no-heading",
    "--color",
    "never",
    // Minified bundles and lockfiles can put megabytes on one line.
    "--max-columns",
    "300",
    "--max-columns-preview",
    "--",
    pattern,
    searchRoot,
  ];
}

export const RG_TEXT_BUDGET = 4000;
const HEAD_BUDGET = 2600;
const TAIL_BUDGET = 1000;

/**
 * Why ripgrep stopped before finishing, or null when it ran to completion.
 *
 * A killed search still leaves its partial stdout behind: spawnSync keeps what
 * it buffered on ENOBUFS and on its timeout, and runWithTimeout keeps the
 * first 10 MB. Counting that as the whole result made the header state a
 * total that was only how far ripgrep got, and the last line was usually cut
 * mid-path.
 */
export function rgStopReason(res: {
  error?: unknown;
  signal?: string | null;
  timedOut?: boolean;
  stderr?: string | null;
}): string | null {
  const code = (res.error as { code?: unknown } | undefined)?.code;
  if (res.timedOut || code === "ETIMEDOUT") return "it timed out";
  if (code === "ENOBUFS" || /stdout capped at/.test(res.stderr ?? "")) return "its output passed the size cap";
  if (res.signal) return `it was killed (${res.signal})`;
  return null;
}

/**
 * Keep `raw` whole when it fits the budget; otherwise keep whole lines from
 * the head and tail and say how many matching lines were omitted.
 *
 * `stoppedEarly` (from `rgStopReason`) marks `raw` as a prefix of the real
 * result: the cut-off last line is dropped and the counts are stated as lower
 * bounds, even when what is left fits the budget.
 */
export function truncateRgText(raw: string, stoppedEarly: string | null = null): string {
  if (stoppedEarly) {
    const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
    const lines = complete.replace(/\n$/, "").split("\n").filter((l) => l.length > 0);
    const note = `[ashlr__grep] ripgrep stopped early because ${stoppedEarly}; at least ${lines.length} matching lines in ${countFiles(lines)} files. Narrow the pattern or cwd.`;
    if (complete.length <= RG_TEXT_BUDGET) return lines.length > 0 ? `${note}\n${lines.join("\n")}` : note;
    return cut(lines, note);
  }
  if (raw.length <= RG_TEXT_BUDGET) return raw;
  const lines = raw.replace(/\n$/, "").split("\n");
  return cut(
    lines,
    `[ashlr__grep] ${lines.length} matching lines in ${countFiles(lines)} files; showing {shown}. Narrow the pattern or cwd to see the rest.`,
  );
}

function countFiles(lines: readonly string[]): number {
  const files = new Set<string>();
  for (const line of lines) {
    const m = /^(.*?):\d+:/.exec(line);
    if (m) files.add(m[1]!);
  }
  return files.size;
}

function cut(lines: readonly string[], header: string): string {
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > HEAD_BUDGET && head.length > 0) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > TAIL_BUDGET) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  const parts = [header.replace("{shown}", String(head.length + tail.length)), ...head];
  if (omitted > 0) parts.push(`[... ${omitted} matching lines omitted ...]`);
  parts.push(...tail);
  return parts.join("\n");
}
