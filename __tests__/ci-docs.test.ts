import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const CI = ".github/workflows/ci.yml";
const CI_DOCS = [
  "README.md",
  "docs/architecture.md",
  "docs/platform-support.md",
  "docs/launch-post.md",
  "docs/producthunt.md",
  "docs/press-kit/founder-bio.md",
];

/** Trigger names declared in the top-level `on:` block of a workflow file. */
function triggers(workflow: string): Set<string> {
  const block = workflow.match(/^on:\n((?:[ \t].*)?(\n|$))+(?=\S)/m)?.[0] ?? "";
  return new Set([...block.matchAll(/^ {2}([a-z_]+)\s*:/gm)].map((m) => m[1]));
}

/** How often the schedule trigger fires, derived from its cron expressions. */
function scheduledCadence(workflow: string): "daily" | "weekly" | "other" {
  const crons = [...workflow.matchAll(/cron:\s*["']([^"']+)["']/g)].map((m) => m[1].trim().split(/\s+/));
  if (!crons.length) return "other";
  if (crons.every((f) => f.slice(2).every((field) => field === "*"))) return "daily";
  if (crons.every((f) => f[2] === "*" && f[3] === "*" && /^\d$/.test(f[4] ?? ""))) return "weekly";
  return "other";
}

const workflow = read(CI);
const events = triggers(workflow);

describe("CI documentation matches the workflow", () => {
  test("every README badge event param is a real ci.yml trigger", () => {
    const badgeEvents = [...read("README.md").matchAll(/actions\/workflows\/ci\.yml[^)\s]*/g)].flatMap((m) =>
      [...m[0].matchAll(/event(?:%3A|=)(\w+)/g)].map((e) => e[1]),
    );
    expect(badgeEvents.length).toBeGreaterThan(0);
    for (const event of badgeEvents) {
      expect(events, `README CI badge queries event=${event}, which never triggers ci.yml`).toContain(event);
    }
  });

  test("docs do not claim CI runs on every push while pushes are not a trigger", () => {
    if (events.has("push")) return;
    const offenders = CI_DOCS.filter((doc) => /CI[^\n]*every push|runs[^\n]*on every push/i.test(read(doc)));
    expect(offenders).toEqual([]);
  });

  test("docs do not claim CI runs for every PR beyond the fast gate", () => {
    const offenders = CI_DOCS.filter((doc) => /full suite[^\n]*every PR|every PR[^\n]*(macOS|Windows|full)/i.test(read(doc)));
    expect(offenders).toEqual([]);
  });

  test("documented benchmark cadence matches the schedule cron", () => {
    const cadence = scheduledCadence(workflow);
    expect(cadence).not.toBe("other");
    const claims: [string, RegExp][] = [
      ["docs/producthunt.md", /benchmark runs (daily|weekly) in CI/i],
      ["docs/press-kit/founder-bio.md", /refreshed (daily|weekly) by CI/i],
      ["docs/launch-post.md", /runs it on the (daily|weekly) schedule/i],
    ];
    for (const [doc, pattern] of claims) {
      const claim = read(doc).match(pattern)?.[1]?.toLowerCase();
      expect(claim, `${doc} documents '${claim}' but the ci.yml schedule is ${cadence}`).toBe(cadence);
    }
  });

  test("docs do not reference label or queue triggers absent from the workflow", () => {
    expect(read("docs/architecture.md")).not.toContain("ci:full");
    if (!events.has("merge_group")) {
      expect(read("docs/architecture.md")).not.toContain("merge-queue");
    }
  });
});
