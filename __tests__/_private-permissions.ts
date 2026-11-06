/** Test-only native privacy evidence; this never changes production ACLs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { windowsProcessEnv, windowsProcessExecutable } from "../scripts/fleet-ghosts";

interface Acl {
  owner: string;
  rules: { sid: string; type: string; rights: number; inheritance: number; propagation: number; inherited: boolean }[];
}
interface NativeAcl { current: string; leaf: Acl; parent: Acl }

const script = `
$ErrorActionPreference = 'Stop'
$p = $env:ASHLR_TEST_ACL_PATH
if ($env:ASHLR_TEST_ACL_BROAD -eq 'yes') {
  $acl = Get-Acl -LiteralPath $p
  $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::ReadData, [System.Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
}
function Snapshot([string]$path) {
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int64]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags; inherited = $_.IsInherited }
  })
  @{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules = $rules }
}
@{ current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; leaf = (Snapshot $p); parent = (Snapshot ([System.IO.Path]::GetDirectoryName($p))) } | ConvertTo-Json -Compress -Depth 5
`;

export function nativeAclSnapshot(path: string, broadFixture = false): NativeAcl {
  assert.equal(process.platform, "win32");
  const leaf = lstatSync(path, { bigint: true });
  assert.ok(leaf.isFile() && leaf.nlink === 1n);
  if (broadFixture) {
    // The only ACL mutation is the controlled negative's fresh, fixed leaf.
    assert.equal(basename(path), "privacy-negative");
    assert.ok(basename(dirname(realpathSync(path))).startsWith("fleet-write-custody-"));
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:/Windows";
  const powershell = windowsProcessExecutable(systemRoot);
  const child = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...windowsProcessEnv(), ASHLR_TEST_ACL_PATH: path, ASHLR_TEST_ACL_BROAD: broadFixture ? "yes" : "no" },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const snapshot = JSON.parse(child.stdout.replace(/^\uFEFF/, "")) as NativeAcl;
  assert.match(snapshot.current, /^S-\d+(?:-\d+)+$/);
  for (const acl of [snapshot.leaf, snapshot.parent]) {
    assert.match(acl.owner, /^S-\d+(?:-\d+)+$/);
    assert.ok(Array.isArray(acl.rules) && acl.rules.length > 0 && acl.rules.length <= 128);
    for (const rule of acl.rules) {
      assert.match(rule.sid, /^S-\d+(?:-\d+)+$/);
      assert.ok(rule.type === "Allow" || rule.type === "Deny");
      assert.ok(Number.isSafeInteger(rule.rights) && rule.rights >= 0);
      assert.ok(Number.isInteger(rule.inheritance) && rule.inheritance >= 0 && rule.inheritance <= 3);
      assert.ok(Number.isInteger(rule.propagation) && rule.propagation >= 0 && rule.propagation <= 3);
      assert.equal(typeof rule.inherited, "boolean");
    }
  }
  return snapshot;
}

export function assertPrivateAcl(snapshot: NativeAcl): void {
  const principals = new Set([snapshot.current, "S-1-5-18", "S-1-5-32-544"]);
  for (const acl of [snapshot.leaf, snapshot.parent]) {
    assert.ok(principals.has(acl.owner), "unexpected native owner SID");
    for (const rule of acl.rules) {
      // InheritOnly describes future children, not access to this object.
      // Applicable inherited ACEs on the actual leaf remain mandatory checks.
      if ((rule.propagation & 2) !== 0) continue;
      // Traverse/synchronize alone disclose no bytes. Reject applicable broad
      // data access or rights that can change the leaf/parent's protection.
      const sensitive = 0xf0000000 | 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40 | 0x80 | 0x100 |
        0x10000 | 0x20000 | 0x40000 | 0x80000;
      assert.ok(rule.type !== "Allow" || !(rule.rights & sensitive) || principals.has(rule.sid),
        `broad native allow grant: ${rule.sid} (${rule.rights})`);
    }
  }
}

export function assertPrivateFilePermissions(path: string): void {
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return;
  }
  const snapshot = nativeAclSnapshot(path);
  // SID/rights metadata only: no token, file contents or user-supplied bodies.
  console.log("WINDOWS_TEST_ACL " + JSON.stringify(snapshot));
  assertPrivateAcl(snapshot);
}
