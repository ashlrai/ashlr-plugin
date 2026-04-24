/**
 * End-to-end integration tests for the ashlr-github MCP server.
 *
 * Stubs the `gh` CLI by prepending a fake bin dir to PATH that dispatches on
 * argv to one of a few canned JSON fixtures. Then spawns the real server and
 * talks to it over JSON-RPC stdio.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }

const INIT = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

function callTool(id: number, name: string, args: Record<string, unknown>): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function rpc(
  reqs: RpcRequest[],
  opts: { home: string; path: string; cwd?: string } = { home: "", path: "" },
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const input = reqs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const serverPath = join(import.meta.dir, "..", "servers", "github-server.ts");
  const proc = spawn({
    cmd: ["bun", "run", serverPath],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: opts.home, PATH: opts.path },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function prFixture(): any {
  return {
    number: 142,
    title: "Add widget caching layer",
    state: "OPEN",
    author: { login: "alice" },
    createdAt: "2026-04-12T12:00:00Z",
    updatedAt: "2026-04-15T09:00:00Z",
    mergeable: "MERGEABLE",
    reviewDecision: "CHANGES_REQUESTED",
    additions: 127,
    deletions: 48,
    changedFiles: 8,
    baseRefName: "main",
    headRefName: "alice/widget-cache",
    body: "This PR introduces a caching layer for widget lookups. " +
      "Rationale: hot path was hammering the DB on every request. ".repeat(20),
    labels: [{ name: "performance" }, { name: "backend" }],
    reviews: [
      { author: { login: "bob" },  state: "APPROVED",          body: "Looks good, ship it." },
      { author: { login: "carol" }, state: "CHANGES_REQUESTED", body: "Need a test for the TTL eviction edge case." },
      { author: { login: "dave" },  state: "COMMENTED",        body: "Nit: rename `k` to `key`." },
    ],
    comments: [
      { author: { login: "carol" }, body: "Please add a comment here explaining the 300s TTL.", path: "src/cache.ts", line: 42 },
      { author: { login: "dave" },  body: "Rename this variable.", path: "src/cache.ts", line: 18, isResolved: true },
      { author: { login: "erin" },  body: "What happens if the cache is unreachable?", path: "src/cache.ts", line: 77 },
    ],
    files: [
      { path: "src/cache.ts", additions: 90, deletions: 10 },
      { path: "src/index.ts", additions: 20, deletions: 30 },
    ],
    statusCheckRollup: [
      { name: "test/unit",    conclusion: "SUCCESS" },
      { name: "test/e2e",     conclusion: "SUCCESS" },
      { name: "test/foo",     conclusion: "FAILURE" },
      { name: "lint",         conclusion: "FAILURE" },
      { name: "build",        conclusion: "SUCCESS" },
      { name: "codeql",       conclusion: "SUCCESS" },
    ],
  };
}

function issueFixture(commentCount: number): any {
  const comments = [];
  for (let i = 0; i < commentCount; i++) {
    comments.push({
      author: { login: `user${i}` },
      createdAt: "2026-04-10T00:00:00Z",
      body: `Comment ${i}: ` + "long content ".repeat(80),
    });
  }
  return {
    number: 77,
    title: "Dashboard crashes on load",
    state: "OPEN",
    author: { login: "zed" },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-13T00:00:00Z",
    body: "Repro steps:\n1. open dashboard\n2. kaboom\n" + "detail ".repeat(200),
    labels: [{ name: "bug" }],
    comments,
  };
}

// ---------------------------------------------------------------------------
// Fake `gh` shell script: dispatches based on subcommand.
// ---------------------------------------------------------------------------

async function installFakeGh(dir: string, opts: {
  pr?: any;
  issue?: any;
  diff?: string;
  repo?: string;
  authOK?: boolean;
  /** When set, `gh api user --jq .login` returns this login. Used for pr_approve self-approval guard tests. */
  viewerLogin?: string;
  /** When set, `gh pr view --json number` (no pr arg) returns this — simulates pr:"current". */
  currentPr?: { number: number; author?: { login?: string } };
}): Promise<string> {
  const binDir = join(dir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const fixturesDir = join(dir, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  if (opts.pr)    await writeFile(join(fixturesDir, "pr.json"),    JSON.stringify(opts.pr));
  if (opts.issue) await writeFile(join(fixturesDir, "issue.json"), JSON.stringify(opts.issue));
  if (opts.diff !== undefined) await writeFile(join(fixturesDir, "diff.txt"), opts.diff);
  if (opts.repo)  await writeFile(join(fixturesDir, "repo.json"),  JSON.stringify({ nameWithOwner: opts.repo }));
  if (opts.viewerLogin) await writeFile(join(fixturesDir, "viewer.txt"), opts.viewerLogin + "\n");
  if (opts.currentPr) await writeFile(join(fixturesDir, "current-pr.json"), JSON.stringify(opts.currentPr));

  // Log all invocations so tests can assert exact argv (write-op tests rely on this).
  const logPath = join(dir, "gh-calls.log");
  await writeFile(logPath, "");

  // A simple dispatcher. Use POSIX shell only so it runs identically under sh/bash/zsh.
  const script = `#!/bin/sh
# Log argv (NUL-separated) for test assertion.
{ for arg in "$@"; do printf '%s\\0' "$arg"; done; printf '\\n'; } >> "${logPath}"
case "$1" in
  auth)
    ${opts.authOK === false ? 'echo "You are not logged into any GitHub hosts." >&2; exit 1' : 'echo "Logged in"; exit 0'}
    ;;
  repo)
    if [ -f "${fixturesDir}/repo.json" ]; then
      cat "${fixturesDir}/repo.json"; exit 0
    else
      echo "no repo" >&2; exit 1
    fi
    ;;
  api)
    # gh api user --jq .login → viewer login
    if [ "$2" = "user" ]; then
      if [ -f "${fixturesDir}/viewer.txt" ]; then
        cat "${fixturesDir}/viewer.txt"; exit 0
      else
        echo "viewer-unknown"; exit 0
      fi
    fi
    ;;
  pr)
    case "$2" in
      view)
        # pr:"current" → runGh calls \`pr view --repo ... --json number,author\` (no PR number).
        # Detect that by checking whether $3 starts with '--'.
        case "$3" in
          --*)
            if [ -f "${fixturesDir}/current-pr.json" ]; then
              cat "${fixturesDir}/current-pr.json"; exit 0
            else
              echo "no current pr" >&2; exit 1
            fi
            ;;
          *)
            cat "${fixturesDir}/pr.json"; exit 0
            ;;
        esac
        ;;
      diff)
        cat "${fixturesDir}/diff.txt"; exit 0
        ;;
      comment)
        # gh pr comment <n> --body <body> --repo <repo>
        echo "https://github.com/${opts.repo || "acme/widgets"}/pull/$3#issuecomment-999"
        exit 0
        ;;
      review)
        # gh pr review <n> --approve --repo <repo> [--body <body>]
        echo "Approved pull request #$3"
        exit 0
        ;;
    esac
    ;;
  issue)
    case "$2" in
      view)
        cat "${fixturesDir}/issue.json"; exit 0
        ;;
      create)
        # gh issue create --title ... --body ... --repo ...
        # Look for the repo argument for URL rendering.
        REPO_ARG="${opts.repo || "acme/widgets"}"
        echo "https://github.com/$REPO_ARG/issues/4242"
        exit 0
        ;;
      close)
        echo "Closed issue #$3"
        exit 0
        ;;
    esac
    ;;
esac
echo "fake gh: unhandled: $@" >&2
exit 2
`;
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script);
  await chmod(ghPath, 0o755);
  return binDir;
}

// Resolve bun's own dir from the test runner (bun is required to spawn the
// server process). Falls back to ~/.bun/bin if Bun.argv0 isn't a full path.
function bunDir(): string {
  const bin = (process as any).execPath as string;
  if (bin && bin.includes("/")) return bin.slice(0, bin.lastIndexOf("/"));
  return `${process.env.HOME}/.bun/bin`;
}

// A PATH that includes the fake bin but also keeps /bin and /usr/bin so `sh`,
// `cat`, `git` still work — and bun's dir so `bun run` succeeds.
function pathWith(binDir: string): string {
  return `${binDir}:${bunDir()}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`;
}

// PATH with NO `gh` on it. Can't just include `${bunDir()}:/usr/bin:/bin`
// because CI runners (ubuntu-latest in particular) pre-install gh at
// /usr/bin/gh — so the test would silently pass on developer macs and fail
// on CI. Build a sandbox bin dir with symlinks to ONLY the tools the MCP
// server needs (sh, git, node) plus bun, then use that dir as PATH.
async function pathWithoutGh(): Promise<string> {
  const sandboxBin = await mkdtemp(join(tmpdir(), "ashlr-nogh-"));
  const needed = ["sh", "git", "node"];
  const searchDirs = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  for (const name of needed) {
    for (const dir of searchDirs) {
      const src = join(dir, name);
      if (existsSync(src)) {
        try { await symlink(src, join(sandboxBin, name)); } catch { /* already linked */ }
        break;
      }
    }
  }
  return `${sandboxBin}:${bunDir()}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ashlr-github · bootstrap", () => {
  test("tools/list exposes ashlr__pr and ashlr__issue", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        { home, path: pathWith(binDir) },
      );
      const names = r.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("ashlr__pr");
      expect(names).toContain("ashlr__issue");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__pr · summary mode", () => {
  let home: string;
  let work: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("renders header, reviews, unresolved comments, checks", async () => {
    const binDir = await installFakeGh(work, { pr: prFixture(), repo: "acme/widgets" });
    const [, r] = await rpc(
      [INIT, callTool(2, "ashlr__pr", { number: 142, repo: "acme/widgets" })],
      { home, path: pathWith(binDir) },
    );
    const text: string = r.result.content[0].text;
    // Header: PR number, state, decision, author, stats.
    expect(text).toMatch(/PR #142/);
    expect(text).toMatch(/OPEN/);
    expect(text).toMatch(/CHANGES_REQUESTED/);
    expect(text).toMatch(/by alice/);
    expect(text).toMatch(/\+127/);
    expect(text).toMatch(/8 files/);
    // Reviews rendered compactly.
    expect(text).toMatch(/reviews \(3\)/);
    expect(text).toMatch(/bob · APPROVED/);
    expect(text).toMatch(/carol · CHANGES_REQUESTED/);
    // Unresolved comments: resolved one (dave/line 18) must be excluded.
    expect(text).toMatch(/unresolved comments \(2\)/);
    expect(text).toMatch(/src\/cache\.ts:42/);
    expect(text).not.toMatch(/src\/cache\.ts:18/);
    // Checks: 4 pass, 2 fail with names.
    expect(text).toMatch(/✓ 4 pass/);
    expect(text).toMatch(/✗ 2 fail/);
    expect(text).toMatch(/test\/foo/);
    expect(text).toMatch(/lint/);
  });
});

describe("ashlr__pr · full mode includes diff", () => {
  test("full mode renders a diff section with snipCompact on large diffs", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      // Large diff — > 2KB so snipCompact kicks in.
      const diff = "diff --git a/x b/x\n" + "+ added line\n".repeat(400);
      const binDir = await installFakeGh(work, { pr: prFixture(), diff, repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 142, repo: "acme/widgets", mode: "full" })],
        { home, path: pathWith(binDir) },
      );
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/diff:/);
      expect(text).toMatch(/diff --git a\/x b\/x/);
      // Diff is very long — snipCompact should elide middle; output shorter than raw.
      expect(text.length).toBeLessThan(diff.length + 2000);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue · thread mode compresses many comments", () => {
  test("20 long comments in thread mode — each comment compressed via snipCompact", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const issue = issueFixture(20);
      const binDir = await installFakeGh(work, { issue, repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue", { number: 77, repo: "acme/widgets", mode: "thread" })],
        { home, path: pathWith(binDir) },
      );
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/Issue #77/);
      expect(text).toMatch(/comments \(20\)/);
      // snipCompact emits an elision marker for long tool_result content.
      expect(text).toMatch(/elided|truncat|\.\.\./i);
      // Must be substantially smaller than the raw JSON.
      const rawSize = JSON.stringify(issue).length;
      expect(text.length).toBeLessThan(rawSize);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue · long body triggers snipCompact", () => {
  test("body > 500 chars is compressed", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const issue = issueFixture(0);
      // issue.body is already very long (repeated 200×). Ensure renders.
      const binDir = await installFakeGh(work, { issue, repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue", { number: 77, repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/Issue #77/);
      expect(text).toMatch(/body:/);
      // snipCompact elides middle when over 2KB; body here is ~1400 — for < 2KB
      // bodies we leave it alone. For this test the expectation is simply that
      // the body is present and the whole rendering is smaller than the raw
      // JSON (the comments section disappears entirely).
      expect(text.length).toBeLessThan(JSON.stringify(issue).length);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__pr · gh missing on PATH", () => {
  test("returns a clear install-hint error", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    try {
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 142, repo: "acme/widgets" })],
        { home, path: await pathWithoutGh() },
      );
      const text: string = r.result.content[0].text;
      expect(r.result.isError).toBe(true);
      expect(text).toMatch(/gh CLI not found/);
      expect(text).toMatch(/brew install gh|cli\.github\.com/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ashlr-github · savings accounting", () => {
  test("ashlr__pr and ashlr__issue both increment lifetime stats", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, {
        pr: prFixture(),
        issue: issueFixture(20),
        repo: "acme/widgets",
      });
      await rpc(
        [
          INIT,
          callTool(2, "ashlr__pr", { number: 142, repo: "acme/widgets" }),
          callTool(3, "ashlr__issue", { number: 77, repo: "acme/widgets", mode: "thread" }),
        ],
        { home, path: pathWith(binDir) },
      );
      const stats = JSON.parse(
        await readFile(join(home, ".ashlr", "stats.json"), "utf-8"),
      );
      expect(stats.lifetime.calls).toBeGreaterThanOrEqual(2);
      expect(stats.lifetime.tokensSaved).toBeGreaterThan(0);
      // byTool should have both entries recorded.
      expect(stats.lifetime.byTool?.ashlr__pr?.calls).toBeGreaterThanOrEqual(1);
      expect(stats.lifetime.byTool?.ashlr__issue?.calls).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Write-op tool tests
// ---------------------------------------------------------------------------

/**
 * Parse the NUL-delimited argv log written by the fake gh script. Each line
 * corresponds to one invocation; args within a line are separated by \0.
 */
async function readGhCalls(dir: string): Promise<string[][]> {
  const raw = await readFile(join(dir, "gh-calls.log"), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\0").filter((a) => a.length > 0));
}

describe("ashlr__pr_comment · happy path", () => {
  test("posts a comment and returns the URL", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [
          INIT,
          callTool(2, "ashlr__pr_comment", { pr: 142, body: "thanks for the review", repo: "acme/widgets" }),
        ],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBeUndefined();
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/commented on PR #142/);
      expect(text).toMatch(/acme\/widgets/);
      expect(text).toMatch(/https:\/\/github\.com\/acme\/widgets\/pull\/142/);

      // Verify argv: gh pr comment 142 --body "thanks..." --repo acme/widgets
      const calls = await readGhCalls(work);
      const commentCall = calls.find((c) => c[0] === "pr" && c[1] === "comment");
      expect(commentCall).toBeDefined();
      expect(commentCall).toContain("142");
      expect(commentCall).toContain("--body");
      expect(commentCall).toContain("thanks for the review");
      expect(commentCall).toContain("--repo");
      expect(commentCall).toContain("acme/widgets");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__pr_comment · missing body is rejected", () => {
  test("returns an error when body is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr_comment", { pr: 142, body: "", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/body.*required/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('ashlr__pr_comment · pr:"current" resolves via `gh pr view`', () => {
  test("resolves to the current branch's PR and comments on it", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, {
        repo: "acme/widgets",
        currentPr: { number: 999, author: { login: "alice" } },
      });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr_comment", { pr: "current", body: "lgtm", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBeUndefined();
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/commented on PR #999/);

      const calls = await readGhCalls(work);
      // Expect a `pr view --repo acme/widgets --json number,author` call before the comment.
      const currentLookup = calls.find(
        (c) => c[0] === "pr" && c[1] === "view" && c[2] === "--repo",
      );
      expect(currentLookup).toBeDefined();
      const commentCall = calls.find((c) => c[0] === "pr" && c[1] === "comment");
      expect(commentCall).toBeDefined();
      expect(commentCall).toContain("999");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__pr_approve · happy path with body", () => {
  test("approves with review body", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, {
        pr: prFixture(), // author: alice
        repo: "acme/widgets",
        viewerLogin: "bob", // viewer differs from author → approval allowed
      });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr_approve", { pr: 142, body: "ship it", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBeUndefined();
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/approved PR #142/);
      expect(text).toMatch(/ship it/);

      const calls = await readGhCalls(work);
      const reviewCall = calls.find((c) => c[0] === "pr" && c[1] === "review");
      expect(reviewCall).toBeDefined();
      expect(reviewCall).toContain("--approve");
      expect(reviewCall).toContain("--body");
      expect(reviewCall).toContain("ship it");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('ashlr__pr_approve · pr:"current" + self-approval guard', () => {
  test("rejects when viewer == PR author", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, {
        pr: prFixture(), // author: alice
        repo: "acme/widgets",
        viewerLogin: "alice",
        currentPr: { number: 142, author: { login: "alice" } },
      });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr_approve", { pr: "current", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/cannot approve your own PR/i);

      // Must NOT have shelled out to `pr review`.
      const calls = await readGhCalls(work);
      const reviewCall = calls.find((c) => c[0] === "pr" && c[1] === "review");
      expect(reviewCall).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue_create · happy path", () => {
  test("creates issue with labels and assignees, returns URL+number", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [
          INIT,
          callTool(2, "ashlr__issue_create", {
            title: "Dashboard crashes on load",
            body: "Repro steps: ...",
            labels: ["bug", "frontend"],
            assignees: ["alice"],
            repo: "acme/widgets",
          }),
        ],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBeUndefined();
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/created issue #4242/);
      expect(text).toMatch(/https:\/\/github\.com\/acme\/widgets\/issues\/4242/);

      const calls = await readGhCalls(work);
      const createCall = calls.find((c) => c[0] === "issue" && c[1] === "create");
      expect(createCall).toBeDefined();
      expect(createCall).toContain("--title");
      expect(createCall).toContain("Dashboard crashes on load");
      expect(createCall).toContain("--body");
      expect(createCall).toContain("--label");
      expect(createCall).toContain("bug,frontend");
      expect(createCall).toContain("--assignee");
      expect(createCall).toContain("alice");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue_create · missing title is rejected", () => {
  test("returns an error when title is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue_create", { title: "", body: "body", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/title.*required/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue_close · happy path with reason", () => {
  test("closes issue with comment and reason", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [
          INIT,
          callTool(2, "ashlr__issue_close", {
            issue: 77,
            comment: "Resolved in #142",
            reason: "completed",
            repo: "acme/widgets",
          }),
        ],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBeUndefined();
      const text: string = r.result.content[0].text;
      expect(text).toMatch(/closed issue #77/);
      expect(text).toMatch(/completed/);

      const calls = await readGhCalls(work);
      const closeCall = calls.find((c) => c[0] === "issue" && c[1] === "close");
      expect(closeCall).toBeDefined();
      expect(closeCall).toContain("77");
      expect(closeCall).toContain("--comment");
      expect(closeCall).toContain("Resolved in #142");
      expect(closeCall).toContain("--reason");
      expect(closeCall).toContain("completed");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__issue_close · invalid reason", () => {
  test("rejects an unrecognized reason", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__issue_close", { issue: 77, reason: "wontfix", repo: "acme/widgets" })],
        { home, path: pathWith(binDir) },
      );
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/invalid reason/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr write ops · ASHLR_REQUIRE_GH_CONFIRM guard", () => {
  test("pr_comment refuses without confirm:true when env flag is set", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      // Have to inline the env into the RPC invocation — spawn in rpc() gets fresh env.
      const serverPath = join(import.meta.dir, "..", "servers", "github-server.ts");
      const proc = spawn({
        cmd: ["bun", "run", serverPath],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWith(binDir),
          ASHLR_REQUIRE_GH_CONFIRM: "1",
        },
      });
      const reqs = [
        INIT,
        callTool(2, "ashlr__pr_comment", { pr: 142, body: "hi", repo: "acme/widgets" }),
      ];
      proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const r = lines[1];
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/ASHLR_REQUIRE_GH_CONFIRM/);

      // Must NOT have shelled out to `pr comment`.
      const calls = await readGhCalls(work);
      const commentCall = calls.find((c) => c[0] === "pr" && c[1] === "comment");
      expect(commentCall).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  test("pr_comment proceeds with confirm:true when env flag is set", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const serverPath = join(import.meta.dir, "..", "servers", "github-server.ts");
      const proc = spawn({
        cmd: ["bun", "run", serverPath],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          PATH: pathWith(binDir),
          ASHLR_REQUIRE_GH_CONFIRM: "1",
        },
      });
      const reqs = [
        INIT,
        callTool(2, "ashlr__pr_comment", {
          pr: 142,
          body: "hi",
          repo: "acme/widgets",
          confirm: true,
        }),
      ];
      proc.stdin.write(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const r = lines[1];
      expect(r.result.isError).toBeUndefined();
      expect(r.result.content[0].text).toMatch(/commented on PR #142/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr-github · write-ops exposed in tools/list", () => {
  test("tools/list includes the four new write-op tools", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      const binDir = await installFakeGh(work, { repo: "acme/widgets" });
      const [, r] = await rpc(
        [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        { home, path: pathWith(binDir) },
      );
      const names = r.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("ashlr__pr_comment");
      expect(names).toContain("ashlr__pr_approve");
      expect(names).toContain("ashlr__issue_create");
      expect(names).toContain("ashlr__issue_close");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("ashlr__pr · repo auto-detect from cwd git remote", () => {
  test("omitting repo parses owner/name from `git remote get-url origin`", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-home-"));
    const work = await mkdtemp(join(tmpdir(), "ashlr-work-"));
    try {
      // We intentionally do NOT write a repo.json fixture — forces fallback
      // to `git remote`. Initialize a real git repo with a github origin.
      const repo = join(work, "proj");
      await mkdir(repo, { recursive: true });
      const sh = (c: string) =>
        Bun.spawnSync({ cmd: ["sh", "-c", c], cwd: repo });
      sh("git init -q && git remote add origin git@github.com:acme/widgets.git");

      // Fake gh: no repo.json, so `gh repo view` will fail; fallback to git.
      const binDir = await installFakeGh(work, { pr: prFixture() });
      const [, r] = await rpc(
        [INIT, callTool(2, "ashlr__pr", { number: 142 })],
        { home, path: pathWith(binDir), cwd: repo },
      );
      const text: string = r.result.content[0].text;
      expect(r.result.isError).toBeUndefined();
      expect(text).toMatch(/PR #142/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});
