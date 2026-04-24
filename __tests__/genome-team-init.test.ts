/**
 * genome-team-init.test.ts — targeted tests for team-init helpers.
 *
 * The full init flow (genome creation, envelope upload, wrap-all fan-out)
 * requires a live server — that path is covered in T6's two-client e2e.
 * Here we cover the pure-function helpers: repo-URL resolution from git +
 * .cloud-id path shape.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { __internals } from "../scripts/genome-team-init";

const { readRepoUrl, cloudIdPath } = __internals;

describe("cloudIdPath", () => {
  it("joins cwd + .ashlrcode/genome/.cloud-id", () => {
    // `cloudIdPath` uses `path.join`, which on Windows emits backslashes.
    // Compare via a POSIX-normalized view so the assertion is portable.
    const expected = "/x/y/.ashlrcode/genome/.cloud-id";
    expect(cloudIdPath("/x/y").replace(/\\/g, "/")).toBe(expected);
  });
});

describe("readRepoUrl", () => {
  it("returns null when the dir is not a git repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ashlr-team-init-"));
    try {
      expect(readRepoUrl(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns the configured remote.origin.url for a real git repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ashlr-team-init-"));
    try {
      // Minimal git init + remote set.
      expect(spawnSync("git", ["-C", tmp, "init", "-q"], { timeout: 2000 }).status).toBe(0);
      writeFileSync(join(tmp, "README.md"), "# hello\n");
      spawnSync("git", ["-C", tmp, "remote", "add", "origin", "https://github.com/acme/widgets.git"], { timeout: 2000 });
      expect(readRepoUrl(tmp)).toBe("https://github.com/acme/widgets.git");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
