#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

const args = [process.execPath, "test"];
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
