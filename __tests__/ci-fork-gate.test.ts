import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fork pull requests run this workflow with a read-only token and no secrets.
// CI Gate has to go green or red on the diff itself. These assertions lock the
// parts that otherwise fail closed on a missing cache write or an unadvertised
// head SHA, and they keep the secret-shape scan on every pull request.

const root = join(import.meta.dir, "..");
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

function job(id: string): string {
  const match = ci.match(new RegExp(`^  ${id}:\\n[\\s\\S]*?(?=^  [a-z0-9-]+:)`, "m"));
  expect(match, `ci.yml has no job ${id}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("CI Gate on fork pull requests", () => {
  test("pull_request and merge_group are unfiltered triggers", () => {
    const on = ci.match(/^on:\n([\s\S]*?)^(?=permissions:)/m)?.[1] ?? "";
    expect(on).toMatch(/^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]\n {2}merge_group:\n/m);
    expect(on).not.toMatch(/^\s+paths:/m);
    expect(ci).not.toContain("pull_request_target");
    expect(ci).not.toContain("workflow_run");
    expect(ci).not.toContain("id-token:");
  });

  test("the required jobs do not read secrets and the gate always reports", () => {
    for (const id of ["fast", "secret-shape", "gate"]) {
      expect(job(id), `${id} must not read secrets`).not.toContain("secrets.");
    }
    const gate = job("gate");
    expect(gate).toContain("name: CI Gate");
    expect(gate).toMatch(/^ {4}if: always\(\)\n/m);
    expect(gate).toContain("needs: [fast, secret-shape, linux, other-os, benchmark, integration-windows]");
    const secret = job("secret-shape");
    expect(secret).toContain("name: Secret-shape scan");
    expect(secret).not.toMatch(/^ {4}if:/m);
    expect(secret).toContain("perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures");
    expect(secret).toContain("5aa902abedbb3bf7fa8d893b93969e247c82ff62ac26cd082215caabfb740265");
  });

  test("a fork pull request restores the cache and does not save it", () => {
    const fast = job("fast");
    expect(fast).toContain("uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0");
    expect(fast).toContain("uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0");
    expect(fast).not.toContain("uses: actions/cache@");
    expect(fast).toContain("github.event.pull_request.head.repo.fork == false");
    expect(fast).toContain("persist-credentials: false");
  });

  test("secret-shape checks out the pull head ref and still diffs the head SHA", () => {
    const secret = job("secret-shape");
    expect(secret).toContain("ref: ${{ github.event_name == 'pull_request' && format('refs/pull/{0}/head', github.event.pull_request.number) || github.sha }}");
    expect(secret).toContain("persist-credentials: false");
    expect(secret).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}");
  });
});

describe("Windows ACL evidence spawn budget", () => {
  test("powershell Get-Acl is allowed 20s on a shared runner", () => {
    const source = readFileSync(join(root, "__tests__/_private-permissions.ts"), "utf8");
    expect(source).toContain("timeout: 20_000");
    expect(source).not.toContain("timeout: 5_000");
  });
});
