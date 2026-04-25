/**
 * Unit tests for genome-rewrap.ts argv translation.
 *
 * Network behavior is exercised end-to-end by genome-team-init's existing
 * --wrap-all path; this file only covers the surface this script adds:
 * mapping --rotate-dek to --force --wrap-all and passing through endpoint/cwd.
 */

import { describe, expect, test } from "bun:test";
import { buildDelegatedArgs } from "../scripts/genome-rewrap";

describe("genome-rewrap.buildDelegatedArgs", () => {
  test("default invocation: --wrap-all only, preserves DEK", () => {
    const argv = buildDelegatedArgs({
      rotateDek: false, endpoint: null, cwd: null, help: false, passthrough: [],
    });
    expect(argv).toEqual(["--wrap-all"]);
  });

  test("--rotate-dek adds --force before --wrap-all", () => {
    const argv = buildDelegatedArgs({
      rotateDek: true, endpoint: null, cwd: null, help: false, passthrough: [],
    });
    expect(argv).toEqual(["--force", "--wrap-all"]);
  });

  test("--endpoint and --cwd are forwarded after the action flags", () => {
    const argv = buildDelegatedArgs({
      rotateDek: false,
      endpoint: "https://staging.api.ashlr.ai",
      cwd: "/tmp/repo",
      help: false,
      passthrough: [],
    });
    expect(argv).toEqual([
      "--wrap-all",
      "--endpoint", "https://staging.api.ashlr.ai",
      "--cwd", "/tmp/repo",
    ]);
  });

  test("passthrough flags are appended last", () => {
    const argv = buildDelegatedArgs({
      rotateDek: true, endpoint: null, cwd: null, help: false, passthrough: ["--quiet"],
    });
    expect(argv).toEqual(["--force", "--wrap-all", "--quiet"]);
  });
});
