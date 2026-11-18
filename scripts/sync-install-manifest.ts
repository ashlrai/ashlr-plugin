import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { buildInstallManifest } from "./lib/install-manifest.ts";

/** Maintainers run doctor:sync after changing shipped instructions or hooks. */
if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  writeFileSync(join(root, ".claude-plugin/install-manifest.json"), JSON.stringify(buildInstallManifest(root)) + "\n");
}
