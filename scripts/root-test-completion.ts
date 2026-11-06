import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
type Element = { name: string; attrs: Record<string, string>; children: Element[] };

function entityText(value: string): string {
  return value.replace(/&([^;&]*);|&/g, (whole, entity: string | undefined) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity && Object.hasOwn(named, entity)) return named[entity]!;
    const digits = entity?.match(/^#(x[0-9a-fA-F]+|[0-9]+)$/)?.[1];
    if (!digits) throw new Error("Invalid completion-report entity");
    const point = digits.startsWith("x") ? Number.parseInt(digits.slice(1), 16) : Number(digits);
    if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      throw new Error("Invalid completion-report character");
    }
    return String.fromCodePoint(point);
  });
}

// A closed parser for the successful Bun JUnit shape. No DTD, processing
// instructions, external entities, text payloads or failure elements are accepted.
// Tokenization honors quoted '>' characters in test names and file paths.
function successTree(source: string): Element {
  if (Buffer.byteLength(source) > MAX_REPORT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) {
    throw new Error("Invalid completion-report size or characters");
  }
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  if (!source.startsWith(declaration)) throw new Error("Missing completion-report declaration");
  let cursor = declaration.length;
  let root: Element | undefined;
  const stack: Element[] = [];
  let nodes = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) {
      if (source.slice(cursor).trim()) throw new Error("Trailing completion-report data");
      break;
    }
    if (source.slice(cursor, start).trim()) throw new Error("Unexpected completion-report text");
    let end = start + 1;
    let quote = "";
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length || quote) throw new Error("Truncated completion report");
    const tag = source.slice(start + 1, end);
    cursor = end + 1;
    if (tag.startsWith("/")) {
      if (stack.pop()?.name !== tag.slice(1)) throw new Error("Mismatched completion-report close");
      continue;
    }
    const match = /^(testsuites|testsuite|testcase|skipped|properties|property)(?=\s|\/|$)/.exec(tag);
    if (!match || ++nodes > 200_000) throw new Error("Unexpected completion-report element");
    const name = match[1]!;
    const selfClosing = tag.endsWith("/");
    let rest = tag.slice(match[0].length, selfClosing ? -1 : undefined);
    const attrs: Record<string, string> = Object.create(null);
    const allowedAttrs: Record<string, string[]> = {
      testsuites: ["name", "tests", "assertions", "failures", "errors", "skipped", "time"],
      testsuite: ["name", "file", "tests", "assertions", "failures", "errors", "skipped", "time", "hostname", "line"],
      testcase: ["name", "classname", "time", "file", "line", "assertions"],
      skipped: [],
      properties: [],
      property: ["name", "value"],
    };
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)=("([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!attr || !allowedAttrs[name]!.includes(attr[1]!) || Object.hasOwn(attrs, attr[1]!)) throw new Error("Invalid completion-report attribute");
      attrs[attr[1]!] = entityText(attr[3] ?? attr[4] ?? "");
      rest = rest.slice(attr[0].length);
    }
    const element: Element = { name, attrs, children: [] };
    const parent = stack.at(-1);
    const validParent = name === "testsuites" ? !parent && !root
      : name === "testsuite" ? parent?.name === "testsuites" || parent?.name === "testsuite"
      : name === "testcase" ? parent?.name === "testsuite"
      : name === "properties" ? parent?.name === "testsuite" && parent.children.length === 0
      : name === "property" ? parent?.name === "properties" : parent?.name === "testcase";
    if (!validParent || stack.length > 128) throw new Error("Invalid completion-report nesting");
    if (parent) parent.children.push(element);
    else root = element;
    if (!selfClosing) stack.push(element);
    if (name === "skipped" && (!selfClosing || Object.keys(attrs).length)) throw new Error("Invalid skipped receipt");
    // Bun adds these inert CI annotations on hosted runners. They never supply
    // authority or counts; the workflow/run/attempt proof is checked separately.
    if (name === "property" && (!selfClosing || Object.keys(attrs).length !== 2 ||
        !["ci", "commit"].includes(attrs.name ?? "") || !attrs.value || attrs.value.length > 4096 ||
        parent!.children.slice(0, -1).some(child => child.attrs.name === attrs.name))) {
      throw new Error("Invalid completion-report CI property");
    }
  }
  if (!root || root.name !== "testsuites" || stack.length) throw new Error("Incomplete completion report");
  return root;
}

function count(element: Element, key: string): number {
  const value = element.attrs[key];
  if (!value || !/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new Error("Invalid completion-report count");
  return Number(value);
}

function fileKey(path: string, root: string): string {
  const absolute = realpathSync(resolve(root, path)).replaceAll("\\", "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function discoverRootTests(root: string): string[] {
  const result: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Test inventory contains a symlink");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) result.push(realpathSync(full));
    }
  }
  walk(join(root, "__tests__"));
  if (!result.length) throw new Error("Test inventory is empty");
  return result;
}

function verifyRootTestTree(receipt: Element, expectedFiles: string[], root: string, reportSha256: string) {
  if (receipt.attrs.name !== "bun test") throw new Error("Unexpected test reporter");
  const expected = new Set(expectedFiles.map(path => fileKey(path, root)));
  if (!expected.size || expected.size !== expectedFiles.length) throw new Error("Invalid expected test inventory");
  const observed = new Set<string>();
  const total = { tests: 0, assertions: 0, skipped: 0 };
  function suiteTotals(suite: Element, file: string): typeof total {
    if (fileKey(suite.attrs.file ?? "", root) !== file) throw new Error("Nested suite changed file identity");
    if (count(suite, "failures") !== 0 || (suite.attrs.errors !== undefined && count(suite, "errors") !== 0)) {
      throw new Error("Test receipt contains failures");
    }
    const seen = { tests: 0, assertions: 0, skipped: 0 };
    for (const child of suite.children) {
      if (child.name === "properties") {
        if (Object.keys(child.attrs).length || child.children.length < 1 || child.children.length > 2 ||
            child.children.some(property => property.name !== "property")) {
          throw new Error("Invalid completion-report CI properties");
        }
        continue;
      }
      if (child.name === "testsuite") {
        const nested = suiteTotals(child, file);
        for (const key of ["tests", "assertions", "skipped"] as const) seen[key] += nested[key];
      } else {
        if (fileKey(child.attrs.file ?? "", root) !== file || child.children.length > 1) {
          throw new Error("Invalid testcase identity");
        }
        seen.tests++;
        seen.skipped += child.children.length;
        seen.assertions += count(child, "assertions");
      }
    }
    for (const key of ["tests", "assertions", "skipped"] as const) {
      if (count(suite, key) !== seen[key]) throw new Error("Testcase totals disagree with suite");
    }
    return seen;
  }
  for (const suite of receipt.children) {
    const key = fileKey(suite.attrs.file ?? "", root);
    if (!expected.has(key) || observed.has(key)) throw new Error("Incomplete or duplicate test-file inventory");
    observed.add(key);
    const seen = suiteTotals(suite, key);
    for (const name of ["tests", "assertions", "skipped"] as const) total[name] += seen[name];
  }
  if (observed.size !== expected.size || total.tests === 0 || total.skipped >= total.tests) {
    throw new Error("Root test suite did not complete its inventory");
  }
  for (const key of ["tests", "assertions", "skipped"] as const) {
    if (count(receipt, key) !== total[key]) throw new Error("Root test totals disagree with suites");
  }
  if (count(receipt, "failures") !== 0 || (receipt.attrs.errors !== undefined && count(receipt, "errors") !== 0)) {
    throw new Error("Root test receipt contains failures");
  }
  const inventory = expectedFiles.map(path => relative(realpathSync(root), realpathSync(resolve(root, path))).replaceAll("\\", "/"))
    .sort((a, b) => Number(a > b) - Number(a < b));
  if (inventory.some(path => path === ".." || path.startsWith("../"))) throw new Error("Test inventory escaped its source root");
  return { schema: "ashlr.root-test-completion.v1", files: observed.size, ...total,
    platform: process.platform, bunVersion: Bun.version,
    inventorySha256: createHash("sha256").update(inventory.join("\n") + "\n").digest("hex"),
    failures: 0, errors: 0, reportSha256 };
}

export function verifyRootTestCompletion(xml: string, expectedFiles: string[], root: string) {
  return verifyRootTestTree(successTree(xml), expectedFiles, root, createHash("sha256").update(xml).digest("hex"));
}

function readReport(path: string, notBeforeMs?: number): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_REPORT_BYTES) {
    throw new Error("Root test report is not a fresh regular bounded file");
  }
  if (notBeforeMs !== undefined && (!Number.isSafeInteger(notBeforeMs) || notBeforeMs <= 0 ||
      stat.mtimeMs < notBeforeMs || stat.ctimeMs < notBeforeMs)) {
    throw new Error("Root test report predates its owned child");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}


export function readRootTestCompletion(path: string, expectedFiles: string[], root: string) {
  return verifyRootTestCompletion(readReport(path), expectedFiles, root);
}

/** Two sequential owned children still prove one exact, complete root suite. */
export function readPartitionedRootTestCompletion(
  partitions: { path: string; expectedFiles: string[]; startedMs: number }[],
  expectedFiles: string[], root: string,
) {
  if (partitions.length !== 2) throw new Error("Unexpected root partition count");
  const canonical = new Set(expectedFiles.map(path => fileKey(path, root)));
  const union = partitions.flatMap(part => part.expectedFiles.map(path => fileKey(path, root)));
  if (canonical.size !== expectedFiles.length || new Set(union).size !== union.length ||
      union.length !== canonical.size || union.some(path => !canonical.has(path)) ||
      partitions.some(part => !part.expectedFiles.length) ||
      new Set(partitions.map(part => realpathSync(part.path))).size !== partitions.length) {
    throw new Error("Root partitions are not an exact disjoint inventory");
  }
  const children: Element[] = [];
  const reports: string[] = [];
  const total = { tests: 0, assertions: 0, skipped: 0 };
  for (const part of partitions) {
    const xml = readReport(part.path, part.startedMs);
    const receipt = verifyRootTestCompletion(xml, part.expectedFiles, root);
    reports.push(receipt.reportSha256);
    children.push(...successTree(xml).children);
    for (const name of ["tests", "assertions", "skipped"] as const) total[name] += receipt[name];
  }
  const combined: Element = { name: "testsuites", attrs: {
    name: "bun test", tests: String(total.tests), assertions: String(total.assertions), skipped: String(total.skipped),
    failures: "0", errors: "0",
  }, children };
  // Windows reportSha256 binds the ordered pair of actual child-report hashes.
  const digest = createHash("sha256").update("ashlr.root-test-partitions.v1\n" + reports.join("\n") + "\n").digest("hex");
  return verifyRootTestTree(combined, expectedFiles, root, digest);
}
