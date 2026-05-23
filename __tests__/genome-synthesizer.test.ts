/**
 * Tests for the Q2 AI-Native Synthesis MVP (`scripts/genome-synthesizer.ts`).
 *
 * Covers the tier-gating contract:
 *   - free tier → synthesizer skips with reason "free-tier" (NO LLM call)
 *   - pro tier + within 7-day window → skipped with "throttled"
 *   - pro tier + outside window → calls LLM, parses, writes discovery sections
 *   - team tier + within 24h window → throttled
 *   - team tier + outside 24h window but inside 7d → still runs
 *   - malformed LLM JSON → drops bad entries, writes only valid ones
 *   - --dry-run → returns would-be output, never writes
 *   - --force → bypasses throttle
 *   - ashlr__grep wires discoveries into retrieval when keywords match
 *
 * NO REAL NETWORK CALLS — every test injects a mock provider. The "free-tier"
 * test additionally asserts the mock was never invoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildSynthesisPrompt,
  parseCliArgs,
  parseSynthesisResponse,
  readSynthesisState,
  resolveTier,
  synthesize,
  writeSynthesisState,
  type SynthesizeOpts,
} from "../scripts/genome-synthesizer";
import {
  DISCOVERIES_SUBDIR,
  commitSectionAbsPath,
  discoverySectionAbsPath,
  loadManifestV2,
  type CommitSection,
  type GenomeManifestV2,
  type SectionMetaV2,
} from "../servers/_manifest-v2";
import { writeCommitSectionFile } from "../servers/_manifest-v2";
import { retrieveDiscoverySections, formatDiscoveriesForPrompt } from "../servers/_genome-discoveries";
import type { LlmProvider } from "../servers/_llm-providers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ashlr-synth-"));
  mkdirSync(join(projectDir, ".ashlrcode", "genome"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Seed a v1 manifest + two commit sections, mimicking the post-Q1 state. */
async function seedGenomeWithCommits(commits: CommitSection[]): Promise<void> {
  const sections: Array<Record<string, unknown>> = [
    {
      path: "knowledge/auth.md",
      title: "Auth flows",
      summary: "auth, login, session, JWT",
      tags: ["auth", "login", "session"],
      tokens: 50,
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceTrust: "static",
      kind: "static",
    },
  ];

  for (const c of commits) {
    await writeCommitSectionFile(projectDir, c);
    sections.push({
      path: `commits/${c.sha}.json`,
      title: `commit ${c.sha.slice(0, 7)} — ${c.message.split("\n")[0]}`,
      summary: c.message.split("\n")[0],
      tags: ["commit", "diff", c.sha.slice(0, 7), ...c.filesChanged.map((p) => p.toLowerCase())],
      tokens: 40,
      updatedAt: c.date,
      lastUpdatedAt: c.date,
      sourceTrust: "commit",
      confidence: 0.9,
      kind: "commit",
    });
  }

  const manifest = {
    version: 1,
    schemaVersion: 2,
    project: "fixture",
    sections,
    generation: { number: 1, milestone: "init", startedAt: "2026-01-01T00:00:00.000Z" },
    fitnessHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(
    join(projectDir, ".ashlrcode", "genome", "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  mkdirSync(join(projectDir, ".ashlrcode", "genome", "knowledge"), { recursive: true });
  writeFileSync(join(projectDir, ".ashlrcode", "genome", "knowledge", "auth.md"), "# auth\n", "utf-8");
}

function sampleCommit(i: number): CommitSection {
  const sha = `${i.toString(16).padStart(40, "a")}`;
  return {
    sha,
    message: `refactor(auth): tighten session validation step ${i}`,
    author: "Tester <t@t.com>",
    date: `2026-05-${(10 + i).toString().padStart(2, "0")}T10:00:00.000Z`,
    filesChanged: ["servers/auth.ts", "servers/session.ts"],
    summary: `# refactor(auth): tighten session validation\n\nstep ${i} cleanup\n`,
  };
}

/** Build a mock provider that returns a canned response and counts calls. */
function mockProvider(response: string): LlmProvider & { calls: number; lastUser: string; lastSystem: string } {
  let calls = 0;
  let lastUser = "";
  let lastSystem = "";
  const p = {
    name: "anthropic" as const,
    isAvailable: async () => true,
    summarize: async (text: string, prompt: string) => {
      calls++;
      lastUser = text;
      lastSystem = prompt;
      return { output: response, inTokens: 100, outTokens: 50, latencyMs: 1 };
    },
  };
  return new Proxy(p, {
    get(target, key) {
      if (key === "calls") return calls;
      if (key === "lastUser") return lastUser;
      if (key === "lastSystem") return lastSystem;
      return (target as unknown as Record<string | symbol, unknown>)[key];
    },
  }) as LlmProvider & { calls: number; lastUser: string; lastSystem: string };
}

/** Build a mock provider that throws — to exercise the llm-failed branch. */
function failingProvider(): LlmProvider {
  return {
    name: "anthropic",
    isAvailable: async () => true,
    summarize: async () => {
      throw new Error("boom");
    },
  };
}

/** A provider whose isAvailable returns false (forces "no-provider"). */
function nonePolyfill(): LlmProvider {
  return {
    name: "none",
    isAvailable: async () => false,
    summarize: async () => {
      throw new Error("should not be called");
    },
  };
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

describe("resolveTier", () => {
  test("explicit tier wins over isProSync()", () => {
    expect(resolveTier({ tier: "free" })).toBe("free");
    expect(resolveTier({ tier: "pro" })).toBe("pro");
    expect(resolveTier({ tier: "team" })).toBe("team");
  });
});

// ---------------------------------------------------------------------------
// Hard gate: free tier never calls the LLM
// ---------------------------------------------------------------------------

describe("free tier — hard gate", () => {
  test("returns { skipped: true, reason: 'free-tier' } without invoking provider", async () => {
    await seedGenomeWithCommits([sampleCommit(1), sampleCommit(2)]);
    let invoked = false;
    const provider: LlmProvider = {
      name: "anthropic",
      isAvailable: async () => true,
      summarize: async () => {
        invoked = true;
        throw new Error("MUST NOT BE CALLED FOR FREE TIER");
      },
    };
    const result = await synthesize({
      cwd: projectDir,
      tier: "free",
      provider,
      force: true, // even with --force, free tier must skip
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("free-tier");
    expect(invoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Throttle window
// ---------------------------------------------------------------------------

describe("throttle window", () => {
  test("pro tier + lastRunAt 2 days ago → throttled (7d window)", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const baseMs = Date.parse("2026-05-22T00:00:00.000Z");
    await writeSynthesisState(projectDir, {
      lastRunAt: new Date(baseMs - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastTier: "pro",
      lastDiscoveryCount: 2,
    });
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider("[]"),
      nowMs: baseMs,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("throttled");
  });

  test("team tier + lastRunAt 36h ago → not throttled (24h window)", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const baseMs = Date.parse("2026-05-22T00:00:00.000Z");
    await writeSynthesisState(projectDir, {
      lastRunAt: new Date(baseMs - 36 * 60 * 60 * 1000).toISOString(),
      lastTier: "team",
      lastDiscoveryCount: 1,
    });
    const validResponse = JSON.stringify([
      {
        summary: "Auth refactor touched session and auth files repeatedly.",
        evidence: [{ path: "servers/auth.ts" }],
        sourceCommits: [sampleCommit(1).sha],
        confidence: 0.7,
      },
    ]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "team",
      provider: mockProvider(validResponse),
      nowMs: baseMs,
    });
    expect(result.skipped).toBe(false);
    expect((result.writtenIds ?? []).length).toBe(1);
  });

  test("--force bypasses the throttle even within window", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const baseMs = Date.parse("2026-05-22T00:00:00.000Z");
    await writeSynthesisState(projectDir, {
      lastRunAt: new Date(baseMs - 60 * 1000).toISOString(),
      lastTier: "pro",
      lastDiscoveryCount: 1,
    });
    const validResponse = JSON.stringify([
      {
        summary: "Auth refactor consolidated session handling.",
        evidence: [{ path: "servers/auth.ts" }],
        sourceCommits: [sampleCommit(1).sha],
        confidence: 0.8,
      },
    ]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      force: true,
      provider: mockProvider(validResponse),
      nowMs: baseMs,
    });
    expect(result.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path: pro tier, outside window, valid LLM response
// ---------------------------------------------------------------------------

describe("pro tier — happy path", () => {
  test("calls the LLM, parses, writes 1-3 discovery sections, updates state", async () => {
    const c1 = sampleCommit(1);
    const c2 = sampleCommit(2);
    await seedGenomeWithCommits([c1, c2]);

    const response = JSON.stringify([
      {
        summary: "Auth refactor introduced a flaky test pattern across session validators.",
        evidence: [
          { path: "servers/auth.ts", lineRange: [12, 40] },
          { path: "servers/session.ts" },
        ],
        sourceCommits: [c1.sha, c2.sha],
        confidence: 0.78,
      },
      {
        summary: "Session validation logic is duplicated between auth.ts and session.ts.",
        evidence: [{ path: "servers/session.ts" }],
        sourceCommits: [c2.sha],
        confidence: 0.6,
      },
    ]);

    const provider = mockProvider(response);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider,
      force: true,
    });

    expect(result.skipped).toBe(false);
    expect((result.writtenIds ?? []).length).toBe(2);

    // Files written
    for (const id of result.writtenIds ?? []) {
      expect(existsSync(discoverySectionAbsPath(projectDir, id))).toBe(true);
    }

    // Manifest updated with kind=discovery + sourceTrust=synthesis
    const m = (await loadManifestV2(projectDir))!;
    const ds = m.sections.filter((s: SectionMetaV2) => s.kind === "discovery");
    expect(ds.length).toBe(2);
    for (const d of ds) {
      expect(d.sourceTrust).toBe("synthesis");
      expect(d.path.startsWith(`${DISCOVERIES_SUBDIR}/`)).toBe(true);
      expect(typeof d.confidence).toBe("number");
    }

    // State file written
    const state = await readSynthesisState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.lastTier).toBe("pro");
    expect(state!.lastDiscoveryCount).toBe(2);
  });

  test("malformed LLM entries are dropped; valid ones still write", async () => {
    const c1 = sampleCommit(1);
    await seedGenomeWithCommits([c1]);

    // 4 entries: 1 valid, 1 missing summary, 1 hallucinated sha, 1 unparseable shape.
    const response = JSON.stringify([
      {
        summary: "Real insight referencing the actual commit.",
        evidence: [{ path: "servers/auth.ts" }],
        sourceCommits: [c1.sha],
        confidence: 0.7,
      },
      { evidence: [{ path: "x.ts" }], sourceCommits: [c1.sha], confidence: 0.5 }, // no summary
      {
        summary: "Hallucinated commit reference.",
        evidence: [],
        sourceCommits: ["ffffffffffffffffffffffffffffffffffffffff"],
        confidence: 0.5,
      },
      "not an object",
    ]);

    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider(response),
      force: true,
    });
    expect(result.skipped).toBe(false);
    expect((result.writtenIds ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LLM-response parsing edge cases
// ---------------------------------------------------------------------------

describe("parseSynthesisResponse", () => {
  test("strips ```json fences", () => {
    const sha = "aaaa";
    const raw = "```json\n[{\"summary\":\"x is a meaningful insight\",\"evidence\":[],\"sourceCommits\":[\"aaaa\"],\"confidence\":0.5}]\n```";
    const out = parseSynthesisResponse(raw, new Set([sha]));
    expect(out.length).toBe(1);
  });

  test("returns [] on invalid JSON", () => {
    expect(parseSynthesisResponse("not json", new Set())).toEqual([]);
    expect(parseSynthesisResponse("{}", new Set())).toEqual([]);
  });

  test("clamps confidence to [0,1]", () => {
    const sha = "aaaa";
    const raw = JSON.stringify([
      { summary: "valid summary text long enough", evidence: [], sourceCommits: [sha], confidence: 5 },
      { summary: "another valid summary", evidence: [], sourceCommits: [sha], confidence: -1 },
    ]);
    const out = parseSynthesisResponse(raw, new Set([sha]));
    expect(out.length).toBe(2);
    expect(out[0]!.confidence).toBe(1);
    expect(out[1]!.confidence).toBe(0);
  });

  test("caps at MAX_DISCOVERIES_PER_RUN (3)", () => {
    const sha = "aaaa";
    const items = Array.from({ length: 6 }, (_, i) => ({
      summary: `valid summary number ${i + 1}`,
      evidence: [],
      sourceCommits: [sha],
      confidence: 0.5,
    }));
    const out = parseSynthesisResponse(JSON.stringify(items), new Set([sha]));
    expect(out.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe("dry-run mode", () => {
  test("does not write any files or update state, returns wouldWriteIds", async () => {
    const c1 = sampleCommit(1);
    await seedGenomeWithCommits([c1]);

    const response = JSON.stringify([
      {
        summary: "Discovered an actionable pattern in the recent commits.",
        evidence: [{ path: "servers/auth.ts" }],
        sourceCommits: [c1.sha],
        confidence: 0.7,
      },
    ]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider(response),
      force: true,
      dryRun: true,
    });
    expect(result.skipped).toBe(false);
    expect((result.wouldWriteIds ?? []).length).toBe(1);
    expect(result.writtenIds).toBeUndefined();
    expect(result.discoveries?.[0]?.summary).toContain("actionable pattern");

    // Nothing on disk.
    expect(existsSync(join(projectDir, ".ashlrcode", "genome", "discoveries"))).toBe(false);
    const state = await readSynthesisState(projectDir);
    expect(state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-genome / no-commits / no-provider / llm-failed branches
// ---------------------------------------------------------------------------

describe("skip branches", () => {
  test("no genome → skipped with no-genome", async () => {
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider("[]"),
      force: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-genome");
  });

  test("no commits → skipped with no-commits", async () => {
    await seedGenomeWithCommits([]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider("[]"),
      force: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-commits");
  });

  test("provider 'none' → skipped with no-provider", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: nonePolyfill(),
      force: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-provider");
  });

  test("provider throws → skipped with llm-failed", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: failingProvider(),
      force: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("llm-failed");
  });

  test("empty array from LLM → skipped with no-discoveries-produced", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const result = await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider("[]"),
      force: true,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-discoveries-produced");
  });
});

// ---------------------------------------------------------------------------
// Privacy: secret-path redaction
// ---------------------------------------------------------------------------

describe("privacy — secret-path redaction", () => {
  test("paths under secrets/ and .env are redacted from the LLM user message", async () => {
    const c1: CommitSection = {
      sha: "1".repeat(40),
      message: "feat: add secret loader",
      author: "Tester <t@t.com>",
      date: "2026-05-22T10:00:00.000Z",
      filesChanged: ["secrets/api-keys.json", ".env.production", "src/loader.ts"],
      summary:
        "# feat\n\n secrets/api-keys.json | 4 ++\n .env.production       | 2 ++\n src/loader.ts         | 3 ++\n",
    };
    await seedGenomeWithCommits([c1]);

    const response = JSON.stringify([
      {
        summary: "Loader pattern reads runtime config from a single helper.",
        evidence: [{ path: "src/loader.ts" }],
        sourceCommits: [c1.sha],
        confidence: 0.7,
      },
    ]);
    const provider = mockProvider(response);
    await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider,
      force: true,
    });
    // The mock recorded what we sent to the LLM.
    expect(provider.lastUser).toContain("[redacted]");
    expect(provider.lastUser).not.toContain("secrets/api-keys.json");
    expect(provider.lastUser).not.toContain(".env.production");
    // Non-secret path still present
    expect(provider.lastUser).toContain("src/loader.ts");
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  test("parses --dry-run, --force, --max-commits=20, --tier=team, --cwd <dir>", () => {
    const a = parseCliArgs(["--dry-run", "--force", "--max-commits=20", "--tier=team", "--cwd", "/tmp/x"]);
    expect(a.dryRun).toBe(true);
    expect(a.force).toBe(true);
    expect(a.maxCommits).toBe(20);
    expect(a.tier).toBe("team");
    expect(a.cwd).toBe("/tmp/x");
  });

  test("default values when nothing passed", () => {
    const a = parseCliArgs([]);
    expect(a.dryRun).toBe(false);
    expect(a.force).toBe(false);
    expect(a.maxCommits).toBe(10);
    expect(a.tier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ashlr__grep integration: discovery retrieval
// ---------------------------------------------------------------------------

describe("retrieveDiscoverySections (ashlr__grep wire-up)", () => {
  test("returns discoveries matching a query, formatted distinctly", async () => {
    const c1 = sampleCommit(1);
    await seedGenomeWithCommits([c1]);
    const response = JSON.stringify([
      {
        summary: "Auth refactor introduced a flaky session validation pattern.",
        evidence: [{ path: "servers/auth.ts" }, { path: "servers/session.ts" }],
        sourceCommits: [c1.sha],
        confidence: 0.78,
      },
    ]);
    await synthesize({
      cwd: projectDir,
      tier: "pro",
      provider: mockProvider(response),
      force: true,
    });

    const hits = await retrieveDiscoverySections(projectDir, "session validation", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.summary).toContain("session validation");
    expect(hits[0]!.sourceCommits).toContain(c1.sha);

    const formatted = formatDiscoveriesForPrompt(hits);
    expect(formatted).toContain("## Discoveries");
    expect(formatted).toContain("[discovery ");
    expect(formatted).toContain("confidence:");
  });

  test("returns empty when no discovery sections exist (backward compat)", async () => {
    await seedGenomeWithCommits([sampleCommit(1)]);
    const hits = await retrieveDiscoverySections(projectDir, "anything", 5);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prompt construction smoke test
// ---------------------------------------------------------------------------

describe("buildSynthesisPrompt", () => {
  test("includes commit SHAs + dates + filenames", () => {
    const c = sampleCommit(1);
    const { system, user } = buildSynthesisPrompt([c], []);
    expect(system).toContain("JSON");
    expect(user).toContain(c.sha);
    expect(user).toContain("servers/auth.ts");
  });
});
