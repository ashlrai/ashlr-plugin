/** Finite metadata-only Windows diagnosis. This is never a full-test receipt. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessTable, windowsProcessEnv, windowsProcessExecutable } from "./fleet-ghosts";

// Fixed local query using the OS .NET Framework assembly. All command lines
// stay in this child; only exact-scalar completion/size/timing metadata leaves.
// https://learn.microsoft.com/en-us/dotnet/api/system.management.managementobjectsearcher?view=netframework-4.8
const WMI_PROCESS_SCALAR = `
[void][System.Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$search = [System.Management.ManagementObjectSearcher]::new('SELECT CommandLine FROM Win32_Process')
try {
  $rows = $search.Get()
  try {
    foreach ($row in $rows) { [void]$row.GetPropertyValue('CommandLine') }
    [Console]::Write('ready')
  } finally { $rows.Dispose() }
} finally { $search.Dispose() }
`;

if (process.platform !== "win32") throw new Error("Windows diagnostics require the actual native platform");
const home = mkdtempSync(join(tmpdir(), "ashlr-windows-diagnostic-"));
const env: NodeJS.ProcessEnv = { ...windowsProcessEnv(), PATH: process.env.PATH,
  HOME: home, USERPROFILE: home, CI: "1", GITHUB_ACTIONS: "1", TESTING: "1",
  ASHLR_DISABLE_CLOUD_LLM: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
const deadline = performance.now() + 8 * 60_000;
let failed = false;
function errno(error: Error | undefined): string | null {
  return error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : null;
}
try {
  // No process command lines or user data: only a fixed scalar startup proof.
  const started = performance.now();
  const probe = spawnSync(windowsProcessExecutable(windowsProcessEnv().SystemRoot!),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('ready')"], {
      env: windowsProcessEnv(), encoding: "utf8", timeout: 5_000,
      maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
  console.log("WINDOWS_STARTUP_PROBE " + JSON.stringify({
    status: probe.status, code: errno(probe.error),
    elapsedMs: Math.round(performance.now() - started),
    exactScalar: probe.stdout === "ready", stderrBytes: Buffer.byteLength(probe.stderr ?? ""),
  }));
  if (probe.status !== 0 || probe.stdout !== "ready" || probe.stderr) failed = true;
  // Bypass unqualified command discovery using only fixed OS module names.
  // Get-Acl inspects only this owned temp directory; WMI output is discarded.
  for (const [name, command] of [
    ["acl-module-qualified", "[void](Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:ASHLR_PROBE_HOME); [Console]::Write('ready')"],
    ["wmi-dotnet-process-read", WMI_PROCESS_SCALAR],
  ]) {
    for (const encoded of [true]) {
      const began = performance.now();
      const args = encoded ? ["-EncodedCommand", Buffer.from(command!, "utf16le").toString("base64")] : ["-Command", command!];
      const child = spawnSync(windowsProcessExecutable(windowsProcessEnv().SystemRoot!),
        ["-NoLogo", "-NoProfile", "-NonInteractive", ...args], {
          env: { ...windowsProcessEnv(), ASHLR_PROBE_HOME: home }, encoding: "utf8", timeout: 5_000,
          maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
      console.log("WINDOWS_CMDLET_PROBE " + JSON.stringify({ name, encoded,
        elapsedMs: Math.round(performance.now() - began), status: child.status, code: errno(child.error),
        exactScalar: child.stdout === "ready", stderrBytes: Buffer.byteLength(child.stderr ?? ""),
      }));
      if (child.status !== 0 || child.stdout !== "ready" || child.stderr) failed = true;
    }
  }
  // Exercise the actual source-owned collector too; command lines stay local.
  const processStarted = performance.now();
  let processRead = false;
  try { processRead = readProcessTable().some(line => line.trim().length > 0); }
  catch { /* Unknown is a failed diagnostic, never an invented empty table. */ }
  console.log("WINDOWS_PROCESS_COLLECTOR_PROBE " + JSON.stringify({
    elapsedMs: Math.round(performance.now() - processStarted), nonempty: processRead,
  }));
  if (!processRead) failed = true;
  // Controlled counterfactual: without native TEMP metadata Windows may
  // initialize a profile-local temp tree. No names or contents leave this test.
  for (const carryNativeTemp of [false, true]) {
    const profile = join(home, carryNativeTemp ? "profile-with-temp" : "profile-without-temp");
    mkdirSync(profile);
    const native: Record<string, string> = { ...windowsProcessEnv(), HOME: profile, USERPROFILE: profile };
    if (!carryNativeTemp) for (const key of ["TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) delete native[key];
    let nonempty = false;
    try { nonempty = readProcessTable("win32", undefined, native).some(line => line.trim().length > 0); }
    catch { /* Report a failed read, without process lines or an exception body. */ }
    const names = new Set(readdirSync(profile, { recursive: true }).map(name => String(name).replaceAll("\\", "/").toLowerCase()));
    const expected = ["appdata", "appdata/local", "appdata/local/temp"];
    console.log("WINDOWS_NATIVE_TEMP_PROBE " + JSON.stringify({ carryNativeTemp, nonempty,
      entries: names.size, profileTempEntries: expected.map(name => names.has(name)),
      unexpectedEntries: [...names].filter(name => !expected.includes(name)).length,
    }));
    if (!nonempty || (carryNativeTemp && names.size !== 0)) failed = true;
  }
  const files = [
    "fleet-blockers-home", "fleet-blockers-needs", "fleet-blockers", "fleet-intent-session",
    "fleet-resources-tool", "fleet-resources", "fleet-share", "fleet-snapshot-mcp", "fleet-watch",
    "fleet-write-custody", "ghost-cli-home-isolation", "repo-savings-hardening", "hook-timings-bounded",
  ] as const;
  for (const name of files) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("finite Windows diagnostics deadline");
    const result = spawnSync(process.execPath, ["test", `__tests__/${name}.test.ts`], {
      env, encoding: "utf8", timeout: Math.min(60_000, Math.ceil(remaining)),
      maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    // Only authored test labels/counts and fixed synthetic native metadata escape
    // the bounded buffers. No raw stdout, stack traces, paths or file contents.
    const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/);
    const labels = lines.filter(line => line.startsWith("(fail) ")).map(line => line.slice(7, 207));
    const summaries = lines.filter(line => /^\s*\d+ (?:pass|fail|skip)\s*$/.test(line));
    console.log("WINDOWS_SELECTED_TEST " + JSON.stringify({ name, status: result.status,
      code: errno(result.error), labels, summaries }));
    for (const line of lines) {
      if (/^(?:WINDOWS_TEST_ACL|WINDOWS_EXCLUSIVE_CREATE_PROBE|HOOK_LEDGER_FAILURE|HOOK_LEDGER_PROGRESS|WINDOWS_BLOCKERS_FIXTURE) /.test(line) && line.length <= 8192) console.log(line);
    }
    if (result.status !== 0) failed = true;
  }
} finally { rmSync(home, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
