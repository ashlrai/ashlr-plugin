import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import inventory from "../../.claude-plugin/install-manifest.json";
import { fileDigest } from "./install-manifest.ts";

export interface DoctorIssue {
  path: string;
  status: "missing" | "stale" | "unreadable";
  fix: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  root: string;
  checked: number;
  issues: DoctorIssue[];
}

/** Compare against the shipped inventory, never an inventory inferred from damaged files. */
export function buildDoctorReport(root: string): DoctorReport {
  root = resolve(root);
  const issues: DoctorIssue[] = [];
  for (const [path, expected] of Object.entries(inventory.files)) {
    let status: DoctorIssue["status"] | undefined;
    try {
      // Do not follow an installed symlink outside the selected plugin tree.
      if (!realpathSync(join(root, path)).startsWith(realpathSync(root) + sep)) status = "unreadable";
      else if (fileDigest(join(root, path)) !== expected) status = "stale";
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
    if (status) issues.push({ path, status, fix: `Reinstall Ashlr in the host that uses this folder to restore ${path}. For an npm install, run: npm install -g ashlr-plugin` });
  }
  return { schemaVersion: 1, ok: issues.length === 0, root, checked: Object.keys(inventory.files).length, issues };
}

export function formatDoctorReport(report: DoctorReport): string {
  return [`ashlr doctor: ${report.ok ? "ok" : "issues found"} (${report.checked} files checked)`,
    `Plugin folder: ${report.root}`,
    ...report.issues.map(issue => `${issue.status}: ${issue.path}\nFix: ${issue.fix}`),
  ].join("\n") + "\n";
}
