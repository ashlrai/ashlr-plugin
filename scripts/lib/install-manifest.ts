import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Normalize checkout line endings so Windows and Unix agree on shipped text.
export const fileDigest = (path: string): string => createHash("sha256")
  .update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex");

export function buildInstallManifest(root: string) {
  const paths = [...new Bun.Glob("{skills,commands,hooks}/**/*").scanSync({ cwd: root, onlyFiles: true })].sort();
  return { schemaVersion: 1, files: Object.fromEntries(paths.map(path => [path, fileDigest(join(root, path))])) };
}
