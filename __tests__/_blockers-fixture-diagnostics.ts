/** Synthetic owned-fixture facts only; no paths, report bodies or file bytes. */
import { isAbsolute, relative } from "node:path";

export function observeBlockersFixture(
  label: string, home: string, expectedRuns: string,
  result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array },
  before: readonly (readonly [string, string])[], after: readonly (readonly [string, string])[],
): void {
  if (process.platform !== "win32") return;
  const normalize = (rows: readonly (readonly [string, string])[]) => new Map(rows.map(([path, value]) => [
    (isAbsolute(path) ? relative(home, path) : path).replaceAll("\\", "/"), value,
  ]));
  const old = normalize(before), current = normalize(after);
  const addedKinds: Record<string, number> = {};
  for (const name of current.keys()) if (!old.has(name)) {
    const lower = name.toLowerCase();
    const kind = lower.includes("bun") ? "bun-cache" : /powershell|microsoft/.test(lower) ? "os-runtime" :
      /dotnet|nuget/.test(lower) ? "dotnet-runtime" : lower.startsWith(".ashlr") ? "fleet-fixture" : "other";
    addedKinds[kind] = (addedKinds[kind] ?? 0) + 1;
  }
  let report: Record<string, unknown> = {};
  let parsed = false;
  try { report = JSON.parse(Buffer.from(result.stdout).toString("utf8")); parsed = !!report && typeof report === "object"; }
  catch { /* The original assertion still rejects invalid JSON. */ }
  const errors = report?.errors && typeof report.errors === "object" ? Object.values(report.errors) : [];
  const allowedErrors = ["unavailable", "unsafe", "missing", "invalid", "too_large", "invalid_utf8"];
  console.error("WINDOWS_BLOCKERS_FIXTURE " + JSON.stringify({
    label, exitCode: result.exitCode, parsed, stderrBytes: result.stderr.byteLength,
    runsMatch: report?.runs === expectedRuns,
    verdict: ["working", "idle", "held", "unknown"].includes(String(report?.verdict)) ? report.verdict : "invalid",
    errorKinds: errors.map(value => allowedErrors.includes(String(value)) ? value : "other"),
    beforeEntries: old.size, afterEntries: current.size, addedKinds,
    removedEntries: [...old.keys()].filter(name => !current.has(name)).length,
    changedEntries: [...old].filter(([name, value]) => current.has(name) && current.get(name) !== value).length,
  }));
}
