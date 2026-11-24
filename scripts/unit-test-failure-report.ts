/**
 * Turn one Bun test failure into a single annotation and a short summary.
 * The full log, including snapshot diffs, stays out of the Actions log.
 *
 * The 20-line assertion excerpt is the length this change was asked to keep.
 * It is not a timeout. Time limits stay on the existing timingBudgetMs path.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ASSERTION_SUMMARY_LINES = 20;
export const FAILURE_LOG = join("test-results", "unit-failure.log");

const FAIL_LINE = /^\(fail\)\s+(.+)$/m;
const LOCATION = /\(([^()\r\n]+?\.(?:[cm]?[jt]sx?|mjs)):(\d+):\d+\)/g;

function failingLocation(log: string): { file: string; line: string } | null {
  const found = [...log.matchAll(LOCATION)].map(match => ({ file: match[1] ?? "", line: match[2] ?? "" }));
  const testFile = found.find(item => item.file.replaceAll("\\", "/").includes("/__tests__/"));
  return testFile ?? found[0] ?? null;
}

export function assertionHead(log: string, lines = ASSERTION_SUMMARY_LINES): string {
  const all = log.split(/\r?\n/);
  const start = all.findIndex(line => line.startsWith("error:") || line.startsWith("error: "));
  if (start < 0) return "";
  const block: string[] = [];
  for (let i = start; i < all.length && block.length < lines; i++) {
    const line = all[i] ?? "";
    if (block.length > 0 && (/^\(fail\) /.test(line) || /^\d+ pass$/.test(line))) break;
    block.push(line);
  }
  return block.join("\n");
}

export function describeUnitFailure(log: string, root = ""): { annotation: string; summary: string; testName: string; file: string; line: string } | null {
  const title = log.match(FAIL_LINE)?.[1]?.replace(/\s+\[\d+(?:\.\d+)?ms\]\s*$/, "").trim();
  const loc = failingLocation(log);
  if (!title && !loc) return null;
  let file = (loc?.file ?? "").replaceAll("\\", "/");
  const base = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (base && (file === base || file.startsWith(`${base}/`))) file = file.slice(base.length).replace(/^\//, "");
  const line = loc?.line ?? "";
  const testName = title || "unit test failed";
  const annotation = file && line
    ? `::error file=${file},line=${line}::${testName}`
    : `::error::${testName}`;
  const where = file && line ? `${file}:${line}` : "unknown";
  const assertion = assertionHead(log);
  const summary = [
    "### First failing unit test",
    "",
    `- Name: ${testName}`,
    `- Location: ${where}`,
    "",
    "Assertion:",
    "",
    "```",
    assertion || "(no assertion text)",
    "```",
    "",
  ].join("\n");
  return { annotation, summary, testName, file, line };
}

export function publishUnitFailure(log: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
  const described = describeUnitFailure(log, root);
  const annotation = described?.annotation ?? "::error::unit tests failed before a file:line was parsed";
  console.error(annotation);
  if (described && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${described.summary}\n`);
  const destination = join(root, FAILURE_LOG);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, log);
  return annotation;
}
