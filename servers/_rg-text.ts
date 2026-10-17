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
 * Keep `raw` whole when it fits the budget; otherwise keep whole lines from
 * the head and tail and say how many matching lines were omitted.
 */
export function truncateRgText(raw: string): string {
  if (raw.length <= RG_TEXT_BUDGET) return raw;
  const lines = raw.replace(/\n$/, "").split("\n");
  const files = new Set<string>();
  for (const line of lines) {
    const m = /^(.*?):\d+:/.exec(line);
    if (m) files.add(m[1]!);
  }

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
  const parts = [
    `[ashlr__grep] ${lines.length} matching lines in ${files.size} files; showing ${head.length + tail.length}. Narrow the pattern or cwd to see the rest.`,
    ...head,
  ];
  if (omitted > 0) parts.push(`[... ${omitted} matching lines omitted ...]`);
  parts.push(...tail);
  return parts.join("\n");
}
