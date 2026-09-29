#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { timingBudgetMs } from "./timing-budget.ts";

const args = [process.execPath, "test"];
// Bun's default per-test timeout is 5s. On shared CI runners (macOS in
// particular) unchanged subprocess-heavy tests regularly take 5-6s, so scale
// the default there; local runs keep Bun's 5s default. Tests with an explicit
// timeout are unaffected.
const defaultTimeoutMs = timingBudgetMs(5_000);
if (defaultTimeoutMs !== 5_000) args.push(`--timeout=${defaultTimeoutMs}`);
// Isolated workers eliminate process-global registry/env races. Windows keeps
// the proven shared mode because several legacy tests intentionally assert
// POSIX-shaped fixtures that Bun normalizes inside isolated Windows workers.
if (process.platform !== "win32") args.push("--parallel=4");
args.push("__tests__");

const child = Bun.spawn({
  cmd: args,
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, ASHLR_STATS_SYNC: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
