/** Verify the exact leaf handle before any append, truncate or permission change. */
import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";

interface WriteIO {
  lstat(path: string): BigIntStats;
  open(path: string, flags: number, mode: number): number;
  fstat(fd: number): BigIntStats;
  close(fd: number): void;
}
const filesystem: WriteIO = {
  lstat: path => lstatSync(path, { bigint: true }),
  open: (path, flags, mode) => openSync(path, flags, mode),
  fstat: fd => fstatSync(fd, { bigint: true }),
  close: fd => closeSync(fd),
};
const regular = (stat: BigIntStats) => stat.isFile() && stat.nlink === 1n && stat.ino > 0n;
const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;

/** Parent custody remains the caller's responsibility. IO injection is internal
 * to deterministic filesystem-race regressions, never selected by tool input.
 * O_NOFOLLOW is additional protection where available; identity checks are
 * mandatory even on platforms where Bun/Node do not implement that flag.
 * The caller owns the returned descriptor and must close it in finally.
 */
export function openVerifiedFleetWrite(path: string, kind: "append" | "overwrite", io: WriteIO = filesystem): number {
  let fd: number | undefined;
  try {
    if (kind !== "append" && kind !== "overwrite") throw new Error("invalid write kind");
    let before: BigIntStats | undefined;
    try { before = io.lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (before && !regular(before)) throw new Error("unsafe existing leaf");
    // Never truncate during open. An absent-path race must fail exclusively,
    // rather than opening a newly substituted link or existing file.
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (kind === "append" ? constants.O_APPEND : 0) |
      (before ? 0 : constants.O_CREAT | constants.O_EXCL);
    fd = io.open(path, flags, 0o600);
    const opened = io.fstat(fd);
    if (!regular(opened) || (before && !same(before, opened))) throw new Error("changed leaf handle");
    const current = io.lstat(path);
    if (!regular(current) || !same(opened, current)) throw new Error("changed leaf name");
    return fd;
  } catch {
    if (fd !== undefined) io.close(fd);
    throw new Error("fleet write path unavailable");
  }
}
