/**
 * Tests for the cloud check section added to scripts/doctor.ts (Track 3).
 *
 * Exercises buildReport() with a mocked pingCloud so no real network call
 * is made. Verifies the cloud section appears with the right status/detail.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "fs/promises";
// scratchHome creates an isolated $HOME dir per test so stats/settings don't
// bleed into the real home directory.
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildReport, formatReport, type BuildOpts, type CloudPingResult } from "../../scripts/doctor.ts";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// Use the real plugin root so node_modules checks pass — we only override
// home, claudeSettingsPath, and the ping function to isolate the cloud check.
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function scratchHome(): Promise<{ home: string; settingsPath: string }> {
  const home = await mkdtemp(join(tmpdir(), "ashlr-doctor-cloud-home-"));
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  // Minimal settings: ashlr allowlist wildcard so allowlist check passes.
  await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["mcp__ashlr-*"] } }));
  return { home, settingsPath };
}

const noopProbe = async () => [
  { server: "efficiency", ok: true, tools: ["ashlr__read"] },
  { server: "sql",        ok: true, tools: ["ashlr__sql"] },
  { server: "bash",       ok: true, tools: ["ashlr__bash"] },
  { server: "tree",       ok: true, tools: ["ashlr__tree"] },
  { server: "http",       ok: true, tools: ["ashlr__http"] },
  { server: "diff",       ok: true, tools: ["ashlr__diff"] },
  { server: "logs",       ok: true, tools: ["ashlr__logs"] },
  { server: "genome",     ok: true, tools: ["ashlr__genome_propose"] },
];
const noFetchLatest = async () => null;
const noBun = async () => null;

async function baseOpts(pingCloud: BuildOpts["pingCloud"]): Promise<BuildOpts> {
  const { home, settingsPath } = await scratchHome();
  return {
    root: PLUGIN_ROOT,
    home,
    claudeSettingsPath: settingsPath,
    fetchLatest: noFetchLatest,
    probe: noopProbe,
    bunVersion: async () => "1.2.0",
    bunOffPath: noBun,
    pingCloud,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("doctor cloud section — healthy", () => {
  test("adds a cloud section with ok status when ping succeeds", async () => {
    const mockPing = async (_url: string, _ms: number): Promise<CloudPingResult> =>
      ({ ok: true, ms: 42 });

    const report = await buildReport(await baseOpts(mockPing));

    const cloudSection = report.sections.find((s) => s.title === "cloud");
    expect(cloudSection).toBeDefined();
    expect(cloudSection!.lines).toHaveLength(1);

    const line = cloudSection!.lines[0]!;
    expect(line.status).toBe("ok");
    expect(line.label).toBe("cloud");
    expect(line.detail).toContain("healthy");
    expect(line.detail).toContain("42ms");
  });

  test("formatted report includes cloud section heading", async () => {
    const mockPing = async (): Promise<CloudPingResult> => ({ ok: true, ms: 10 });
    const report = await buildReport(await baseOpts(mockPing));
    const formatted = formatReport(report);
    expect(formatted).toContain("cloud");
  });
});

describe("doctor cloud section — unreachable", () => {
  test("adds warn line when ping times out", async () => {
    const mockPing = async (): Promise<CloudPingResult> =>
      ({ ok: false, ms: 3001, error: "timeout" });

    const report = await buildReport(await baseOpts(mockPing));

    const cloudSection = report.sections.find((s) => s.title === "cloud");
    expect(cloudSection).toBeDefined();
    const line = cloudSection!.lines[0]!;
    expect(line.status).toBe("warn");
    expect(line.detail).toContain("unreachable");
    expect(line.detail).toContain("timeout");
    expect(line.fix).toBeDefined();
    expect(line.fix).toContain("ASHLR_API_URL_DISABLE=1");
  });

  test("warn for unreachable does NOT add cloud failures (non-fatal)", async () => {
    // Run twice: once with cloud healthy, once with cloud unreachable.
    // The failure count must be identical — cloud unreachable must not add
    // any new failure lines.
    const healthyPing = async (): Promise<CloudPingResult> => ({ ok: true, ms: 5 });
    const deadPing = async (): Promise<CloudPingResult> =>
      ({ ok: false, ms: 100, error: "connection refused" });

    const healthy = await buildReport(await baseOpts(healthyPing));
    const unreachable = await buildReport(await baseOpts(deadPing));

    expect(unreachable.failures).toBe(healthy.failures);

    // Also verify the cloud section itself is warn not fail
    const cloudSection = unreachable.sections.find((s) => s.title === "cloud");
    expect(cloudSection!.lines[0]!.status).toBe("warn");
  });

  test("warn detail includes the error string", async () => {
    const mockPing = async (): Promise<CloudPingResult> =>
      ({ ok: false, ms: 50, error: "ECONNREFUSED" });

    const report = await buildReport(await baseOpts(mockPing));
    const cloudSection = report.sections.find((s) => s.title === "cloud");
    const line = cloudSection!.lines[0]!;
    expect(line.detail).toContain("ECONNREFUSED");
  });
});

describe("doctor cloud section — disabled", () => {
  test("shows disabled line when ASHLR_API_URL_DISABLE=1", async () => {
    const mockPing = async (): Promise<CloudPingResult> => ({ ok: true, ms: 1 });

    const orig = process.env["ASHLR_API_URL_DISABLE"];
    process.env["ASHLR_API_URL_DISABLE"] = "1";
    try {
      const report = await buildReport(await baseOpts(mockPing));
      const cloudSection = report.sections.find((s) => s.title === "cloud");
      expect(cloudSection).toBeDefined();
      const line = cloudSection!.lines[0]!;
      expect(line.detail).toContain("disabled");
      expect(line.detail).toContain("ASHLR_API_URL_DISABLE=1");
    } finally {
      if (orig === undefined) delete process.env["ASHLR_API_URL_DISABLE"];
      else process.env["ASHLR_API_URL_DISABLE"] = orig;
    }
  });
});

describe("doctor cloud section — ASHLR_API_URL override", () => {
  test("passes the configured URL to pingCloud", async () => {
    let capturedUrl = "";
    const mockPing = async (url: string): Promise<CloudPingResult> => {
      capturedUrl = url;
      return { ok: true, ms: 5 };
    };

    const orig = process.env["ASHLR_API_URL"];
    process.env["ASHLR_API_URL"] = "http://localhost:3000";
    try {
      await buildReport(await baseOpts(mockPing));
      expect(capturedUrl).toBe("http://localhost:3000");
    } finally {
      if (orig === undefined) delete process.env["ASHLR_API_URL"];
      else process.env["ASHLR_API_URL"] = orig;
    }
  });
});
