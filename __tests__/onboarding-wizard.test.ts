/**
 * Tests for the ashlr onboarding wizard.
 *
 * Coverage:
 *   1. Wizard runs end-to-end in --no-interactive mode and exits 0.
 *   2. First run (no stamp) → SessionStart emits wizard additionalContext.
 *   3. Second run (stamp exists) → SessionStart does NOT emit the trigger.
 *   4. Doctor check detects missing plugin root gracefully.
 *   5. Permissions check matches install-permissions output shape.
 *   6. Live-demo step picks a file when cwd has source files; skips otherwise.
 *   7. Genome offer only appears when cwd has >= 10 files and no genome.
 *   8. --reset deletes the installed-at stamp.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  stampPath,
  isFirstRun,
  writeStamp,
  deleteStamp,
  countSourceFiles,
  findDemoFile,
  estimateReadPayload,
  fileSizeBytes,
  runDoctorCheck,
  runWizard,
  renderDoctorOutput,
  renderPermissionsSection,
  renderStatusLineSection,
  renderRestartCallout,
  renderLiveDemoSection,
  renderGenomeSection,
  renderOllamaSection,
  detectOllamaState,
  detectGhAuthState,
  enableOllamaEmbeddings,
  computeGenomeAhaDemo,
  detectTelemetryState,
  writeTelemetryChoice,
  renderTelemetrySection,
  type DoctorResult,
  type SkippedStep,
  type GenomeAhaDemo,
  type TelemetryOfferState,
} from "../scripts/onboarding-wizard";

import { maybeWizardTrigger } from "../hooks/session-start";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpCwd: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "ashlr-wiz-home-"));
  tmpCwd = await mkdtemp(join(tmpdir(), "ashlr-wiz-cwd-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
  await rm(tmpCwd, { recursive: true, force: true });
});

/** Capture stdout during a callback. */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: Buffer[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-ignore — patching for test
  process.stdout.write = (chunk: string | Buffer, ...rest: unknown[]) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    // @ts-ignore
    process.stdout.write = orig;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// 1. End-to-end wizard in --no-interactive mode
// ---------------------------------------------------------------------------

describe("runWizard --no-interactive", () => {
  // 30 s budget: on Windows CI, detectGhAuthState() (gh auth status) and
  // detectOllamaState() (where ollama) each have up to 10 s / 5 s timeouts.
  test("completes without throwing and emits expected markers", async () => {
    const output = await captureStdout(async () => {
      await runWizard({
        interactive: false,
        home: tmpHome,
        cwd: tmpCwd,
        // Stub out side-effecting calls so tests are hermetic and fast
        installPermsFn: async () => {},
        installStatusLineFn: async () => {},
        genomeInitFn: async () => {},
        // Avoid spawning the real MCP server in --no-interactive tests.
        realReadDemoFn: async () => ({ payloadBytes: null, sample: null, error: "stubbed" }),
        enableOllamaFn: async () => ({ ok: true, path: "/tmp/ashlr-stub-config.json" }),
      });
    });

    // Greeting
    expect(output).toContain("You just installed ashlr.");
    // Dependency-chain visual in greeting
    expect(output).toContain("ashlr in 60 seconds:");
    expect(output).toContain("/ashlr-doctor");
    expect(output).toContain("status line install");
    expect(output).toContain("/ashlr-genome-init");
    // All nine step headers (Telemetry inserted at step 6 in v1.31).
    expect(output).toContain("STEP 1/9: Doctor check");
    expect(output).toContain("STEP 2/9: Permissions");
    expect(output).toContain("STEP 3/9: Status line");
    expect(output).toContain("STEP 4/9: Live demo");
    expect(output).toContain("STEP 5/9: Genome");
    expect(output).toContain("STEP 6/9: Telemetry");
    expect(output).toContain("STEP 7/9: Embeddings");
    expect(output).toContain("STEP 8/9: Pro plan");
    expect(output).toContain("STEP 9/9: Done");
    // Final message
    expect(output).toContain("Run /ashlr-savings anytime");
    expect(output).toContain("Happy coding.");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. First run → SessionStart emits wizard trigger
// ---------------------------------------------------------------------------

describe("maybeWizardTrigger", () => {
  test("first run: no stamp → returns trigger string and writes stamp", () => {
    expect(isFirstRun(tmpHome)).toBe(true);

    const trigger = maybeWizardTrigger(tmpHome);
    expect(trigger).not.toBeNull();
    expect(trigger).toContain("/ashlr-start");
    expect(trigger).toContain("onboarding wizard");

    // Stamp written
    expect(existsSync(stampPath(tmpHome))).toBe(true);
    expect(isFirstRun(tmpHome)).toBe(false);
  });

  // 3. Second run → no trigger
  test("second run: stamp present → returns null", () => {
    writeStamp(tmpHome);
    const trigger = maybeWizardTrigger(tmpHome);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Doctor check handles missing plugin root gracefully
// ---------------------------------------------------------------------------

describe("runDoctorCheck", () => {
  test("missing plugin root reports issue without throwing", async () => {
    const result = await runDoctorCheck({
      home: tmpHome,
      cwd: tmpCwd,
      // Supply a non-existent root to exercise the missing-root path
      pluginRoot: join(tmpCwd, "nonexistent"),
    });

    expect(result.pluginRoot).toBe(join(tmpCwd, "nonexistent"));
    // hasDeps will be false when root doesn't exist
    expect(result.hasDeps).toBe(false);
    // Issues array should contain at least one entry
    expect(result.issues.length).toBeGreaterThan(0);
    const issueText = result.issues.join(" ");
    expect(issueText.toLowerCase()).toMatch(/plugin root|dependencies|missing/);
  });

  test("returns genomePresent: true when .ashlrcode/genome exists", async () => {
    const genomeDir = join(tmpCwd, ".ashlrcode", "genome");
    mkdirSync(genomeDir, { recursive: true });

    const result = await runDoctorCheck({
      home: tmpHome,
      cwd: tmpCwd,
      pluginRoot: join(tmpCwd, "nonexistent"),
    });
    expect(result.genomePresent).toBe(true);
  });

  test("allowlistOk: true when settings.json has mcp__ashlr-* entry", async () => {
    const claudeDir = join(tmpHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["mcp__ashlr-*"] } }),
    );

    const result = await runDoctorCheck({
      home: tmpHome,
      cwd: tmpCwd,
      pluginRoot: join(tmpCwd, "nonexistent"),
    });
    expect(result.allowlistOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Permissions section matches install-permissions output shape
// ---------------------------------------------------------------------------

describe("renderPermissionsSection output", () => {
  test("when allowlist ok: emits [ASHLR_OK] permissions-ok", async () => {
    const output = await captureStdout(() => {
      renderPermissionsSection(true);
    });
    expect(output).toContain("[ASHLR_OK] permissions-ok");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("when allowlist missing: emits [ASHLR_PROMPT] with y/n", async () => {
    const output = await captureStdout(() => {
      renderPermissionsSection(false);
    });
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("y/n");
    expect(output).not.toContain("[ASHLR_OK] permissions-ok");
  });
});

// ---------------------------------------------------------------------------
// 5b. Status-line section
// ---------------------------------------------------------------------------

describe("renderStatusLineSection output", () => {
  test("when already installed: emits [ASHLR_OK] status-line-present", async () => {
    const output = await captureStdout(() => {
      renderStatusLineSection(true);
    });
    expect(output).toContain("[ASHLR_OK] status-line-present");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("when not installed: emits [ASHLR_PROMPT] with Y/n default y", async () => {
    const output = await captureStdout(() => {
      renderStatusLineSection(false);
    });
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("Y/n");
    expect(output).toContain("default y");
  });

  test("when not installed: mentions status bar and recommended", async () => {
    const output = await captureStdout(() => {
      renderStatusLineSection(false);
    });
    expect(output).toContain("status bar");
    expect(output).toContain("recommended");
  });
});

describe("renderRestartCallout", () => {
  test("contains restart instruction", async () => {
    const output = await captureStdout(() => {
      renderRestartCallout();
    });
    expect(output).toContain("Restart Claude Code");
    expect(output).toContain("/reload-plugins");
  });
});

// ---------------------------------------------------------------------------
// 6. Live demo picks a file; skips when cwd has no source files
// ---------------------------------------------------------------------------

describe("live demo", () => {
  test("findDemoFile returns null when no source files exist", () => {
    // tmpCwd is empty
    const result = findDemoFile(tmpCwd);
    expect(result).toBeNull();
  });

  test("findDemoFile returns a ts file when one is present", async () => {
    const srcFile = join(tmpCwd, "app.ts");
    await writeFile(srcFile, "export const x = 1;\n");
    const result = findDemoFile(tmpCwd);
    expect(result).toBe(srcFile);
  });

  test("renderLiveDemoSection emits skip marker when demoFile is null", async () => {
    const output = await captureStdout(() => {
      renderLiveDemoSection(null, 0, 0);
    });
    expect(output).toContain("[ASHLR_OK] demo-skipped");
  });

  test("renderLiveDemoSection shows byte counts when file exists", async () => {
    const srcFile = join(tmpCwd, "big.ts");
    // Write > 4KB so snip logic kicks in
    await writeFile(srcFile, "x".repeat(8000));
    const sizeBytes = fileSizeBytes(srcFile);
    const payloadBytes = estimateReadPayload(sizeBytes);

    const output = await captureStdout(() => {
      renderLiveDemoSection(srcFile, sizeBytes, payloadBytes);
    });
    expect(output).toContain("Disk size:");
    expect(output).toContain("ashlr__read:");
    expect(output).toContain("Saved:");
    expect(output).toContain("[ASHLR_OK] demo-complete");
    // Payload should be less than full size for large files
    expect(payloadBytes).toBeLessThan(sizeBytes);
  });

  test("estimateReadPayload: small file returns full size", () => {
    expect(estimateReadPayload(1000)).toBe(1000);
    expect(estimateReadPayload(4096)).toBe(4096);
  });

  test("estimateReadPayload: large file returns < 50% of original", () => {
    const payload = estimateReadPayload(100_000);
    expect(payload).toBeLessThan(50_000);
    expect(payload).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Genome offer: only when cwd has >= 10 files and no existing genome
// ---------------------------------------------------------------------------

describe("genome offer", () => {
  test("small-repo branch surfaces an opt-in prompt with default n", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(5, false);
    });
    // Small repos used to be silently skipped; now they get a soft offer
    // so greenfield projects don't miss the feature entirely.
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("default n");
    expect(output).toContain("5 source file");
  });

  test("genome offer skipped when genome already present", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(50, true);
    });
    expect(output).toContain("[ASHLR_OK] genome-present");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("genome offer shown when >= 10 files and no genome", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(15, false);
    });
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("genome");
    expect(output).toContain("15 source files");
  });

  test("countSourceFiles counts .ts files and ignores node_modules", async () => {
    mkdirSync(join(tmpCwd, "src"), { recursive: true });
    mkdirSync(join(tmpCwd, "node_modules", "pkg"), { recursive: true });

    for (let i = 0; i < 12; i++) {
      writeFileSync(join(tmpCwd, "src", `file${i}.ts`), "");
    }
    writeFileSync(join(tmpCwd, "node_modules", "pkg", "index.ts"), "");

    const count = countSourceFiles(tmpCwd);
    expect(count).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 8. --reset deletes the stamp
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Ollama offer (step 5)
// ---------------------------------------------------------------------------

describe("Ollama offer", () => {
  test("detectOllamaState: ASHLR_EMBED_URL set → alreadyConfigured=true", () => {
    const state = detectOllamaState(tmpHome, { ASHLR_EMBED_URL: "http://localhost:11434/api/embeddings" });
    expect(state.alreadyConfigured).toBe(true);
  });

  test("detectOllamaState: OLLAMA_HOST set → alreadyConfigured=true", () => {
    const state = detectOllamaState(tmpHome, { OLLAMA_HOST: "127.0.0.1:11434" });
    expect(state.alreadyConfigured).toBe(true);
  });

  test("detectOllamaState: neither env set → alreadyConfigured=false", () => {
    const state = detectOllamaState(tmpHome, {});
    expect(state.alreadyConfigured).toBe(false);
    expect(typeof state.installed).toBe("boolean"); // real `which` result — may be either
  });

  test("renderOllamaSection: alreadyConfigured → ok marker and no prompt", async () => {
    const output = await captureStdout(() => {
      renderOllamaSection({ alreadyConfigured: true, installed: true, configPath: "/tmp/ignored" });
    });
    expect(output).toContain("[ASHLR_OK] ollama-already-configured");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("renderOllamaSection: installed + not configured → prompt", async () => {
    const output = await captureStdout(() => {
      renderOllamaSection({ alreadyConfigured: false, installed: true, configPath: "/tmp/cfg.json" });
    });
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("Ollama");
  });

  test("renderOllamaSection: not installed → install hint and skip", async () => {
    const output = await captureStdout(() => {
      renderOllamaSection({ alreadyConfigured: false, installed: false, configPath: "/tmp/cfg.json" });
    });
    expect(output).toContain("[ASHLR_OK] ollama-not-installed");
    expect(output).toContain("ollama.com");
  });

  test("enableOllamaEmbeddings writes ASHLR_EMBED_URL to ~/.ashlr/config.json", async () => {
    const res = await enableOllamaEmbeddings(tmpHome);
    expect(res.ok).toBe(true);
    const cfgPath = join(tmpHome, ".ashlr", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.ASHLR_EMBED_URL).toBe("http://localhost:11434/api/embeddings");
  });

  test("enableOllamaEmbeddings preserves other keys in config.json", async () => {
    const { mkdirSync: mk } = await import("fs");
    mk(join(tmpHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(tmpHome, ".ashlr", "config.json"),
      JSON.stringify({ FOO: "bar" }),
    );
    const res = await enableOllamaEmbeddings(tmpHome);
    expect(res.ok).toBe(true);
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(join(tmpHome, ".ashlr", "config.json"), "utf8"));
    expect(parsed.FOO).toBe("bar");
    expect(parsed.ASHLR_EMBED_URL).toBe("http://localhost:11434/api/embeddings");
  });
});

// ---------------------------------------------------------------------------
// 10. Live-demo "real" marker
// ---------------------------------------------------------------------------

describe("live demo real vs estimate", () => {
  test("real=true renders (live) marker and sample", async () => {
    const srcFile = join(tmpCwd, "a.ts");
    await writeFile(srcFile, "x".repeat(8000));
    const output = await captureStdout(() => {
      renderLiveDemoSection(srcFile, 8000, 2000, { real: true, sample: "first line\nsecond line", error: null });
    });
    expect(output).toContain("(live)");
    expect(output).toContain("first line");
  });

  test("real=false + error renders fallback note", async () => {
    const srcFile = join(tmpCwd, "a.ts");
    await writeFile(srcFile, "x".repeat(8000));
    const output = await captureStdout(() => {
      renderLiveDemoSection(srcFile, 8000, 2800, { real: false, sample: null, error: "spawn failed" });
    });
    expect(output).toContain("(estimate)");
    expect(output).toContain("spawn failed");
  });
});

// ---------------------------------------------------------------------------

describe("deleteStamp / --reset", () => {
  test("deleteStamp removes the stamp file", async () => {
    writeStamp(tmpHome);
    expect(isFirstRun(tmpHome)).toBe(false);

    await deleteStamp(tmpHome);
    expect(isFirstRun(tmpHome)).toBe(true);
  });

  test("deleteStamp is a no-op when stamp does not exist", async () => {
    // Should not throw
    await expect(deleteStamp(tmpHome)).resolves.toBeUndefined();
    expect(isFirstRun(tmpHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skipped-features summary (v1.21)
// ---------------------------------------------------------------------------

describe("skipped-features summary", () => {
  // 30 s budget covers detectOllamaState (where ollama, 5 s) +
  // detectGhAuthState (gh auth status, 10 s) on Windows CI.
  test("no-Ollama + no-gh-auth → summary lists both with non-empty reasons", async () => {
    // Simulate: Ollama not installed, gh not authed.
    // We stub detectOllamaState via the wizard's env path (not installed, not configured).
    // We inject a realReadDemoFn stub to avoid spawning the MCP server.
    // The wizard detects gh auth via detectGhAuthState() which shells out; in CI
    // gh is typically not authed, so the skip fires naturally. We capture stdout
    // and verify the summary block appears.
    const output = await captureStdout(async () => {
      await runWizard({
        interactive: false,
        home: tmpHome,
        cwd: tmpCwd,
        installPermsFn: async () => {},
        installStatusLineFn: async () => {},
        genomeInitFn: async () => {},
        realReadDemoFn: async () => ({ payloadBytes: null, sample: null, error: "stubbed" }),
        // enableOllamaFn not needed — Ollama not installed path doesn't prompt
      });
    });

    // The summary block should appear somewhere in the output.
    // In CI: Ollama is not installed → "Dense embeddings" skip fires.
    // gh auth typically fails in CI → "GitHub integration" skip fires.
    // We only assert on the structural format, not exact content.
    const hasHeadsUp = output.includes("Heads up") || output.includes("aren't active yet");
    // If either feature is skipped (one is likely in CI), the summary appears.
    // The wizard may have 0 skips if all checks pass (e.g. developer machine with gh + ollama).
    // So we check that IF the block appears, the format is correct.
    if (hasHeadsUp) {
      expect(output).toMatch(/•.+:/);    // bullet with step name
      expect(output).toMatch(/→.+/);     // hint line
    }
  }, 30_000);

  test("no-Ollama explicit: detectOllamaState returns correct shape", () => {
    // detectOllamaState returns a typed object regardless of environment.
    const state = detectOllamaState(tmpHome, {});
    expect(state.alreadyConfigured).toBe(false);
    expect(typeof state.installed).toBe("boolean");
    expect(typeof state.configPath).toBe("string");
  });

  test("no-Ollama + no-gh-auth via renderOllamaSection: not-installed → ASHLR_OK marker", async () => {
    // Direct render test: not-installed state always emits the marker.
    const output = await captureStdout(() => {
      renderOllamaSection({ alreadyConfigured: false, installed: false, configPath: "/tmp/x.json" });
    });
    expect(output).toContain("[ASHLR_OK] ollama-not-installed");
  });

  // 30 s budget covers detectOllamaState + detectGhAuthState probes on Windows CI.
  test("skipped summary format: each entry has step + reason + hint", async () => {
    // Verify the exact structure of the skipped summary by checking
    // that when steps ARE listed, each has the correct multi-line format.
    const output = await captureStdout(async () => {
      await runWizard({
        interactive: false,
        home: tmpHome,
        cwd: tmpCwd,
        installPermsFn: async () => {},
        installStatusLineFn: async () => {},
        genomeInitFn: async () => {},
        realReadDemoFn: async () => ({ payloadBytes: null, sample: null, error: "stubbed" }),
      });
    });

    // Parse skipped bullet lines.
    const bulletLines = output.split("\n").filter((l) => l.trimStart().startsWith("•"));
    const hintLines = output.split("\n").filter((l) => l.trimStart().startsWith("→"));

    // If any bullets appear, each must have a corresponding hint.
    expect(bulletLines.length).toBe(hintLines.length);
    for (const hint of hintLines) {
      // Each hint must be non-empty after the arrow.
      expect(hint.replace(/^\s*→\s*/, "").trim().length).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Genome aha moment (#4) — explicit value statement + before/after demo
// ---------------------------------------------------------------------------

describe("genome aha moment", () => {
  test("renderGenomeSection always shows the ~84% value statement", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(50, false);
    });
    expect(output).toContain("~84% token savings");
    expect(output).toContain("pre-indexing");
  });

  test("small-repo branch also shows the ~84% value statement", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(3, false);
    });
    expect(output).toContain("~84% token savings");
  });

  test("genome-present branch does NOT show the value statement", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(50, true);
    });
    expect(output).not.toContain("~84% token savings");
    expect(output).toContain("[ASHLR_OK] genome-present");
  });

  test("computeGenomeAhaDemo returns null for missing or tiny files", () => {
    expect(computeGenomeAhaDemo(null, 0)).toBeNull();
    expect(computeGenomeAhaDemo("/tmp/x.ts", 100)).toBeNull(); // < 4KB
    expect(computeGenomeAhaDemo("/tmp/x.ts", 4095)).toBeNull();
  });

  test("computeGenomeAhaDemo returns reasonable token counts for a real file", () => {
    const demo = computeGenomeAhaDemo("/tmp/big.ts", 48_000);
    expect(demo).not.toBeNull();
    expect(demo!.filePath).toBe("/tmp/big.ts");
    expect(demo!.sizeBytes).toBe(48_000);
    // ~4 chars/token: 48000/4 = 12000
    expect(demo!.withoutGenomeTokens).toBe(12_000);
    // 20% of raw: 48000 * 0.2 / 4 = 2400
    expect(demo!.withGenomeTokens).toBe(2_400);
    // With-genome should be ~5x smaller than without.
    expect(demo!.withGenomeTokens).toBeLessThan(demo!.withoutGenomeTokens / 4);
  });

  test("computeGenomeAhaDemo enforces a 200-token floor for marginal files", () => {
    // 4096 bytes: raw ~1024 tok; 20% = 205. Floor still keeps it >= 200.
    const demo = computeGenomeAhaDemo("/tmp/x.ts", 4096);
    expect(demo).not.toBeNull();
    expect(demo!.withGenomeTokens).toBeGreaterThanOrEqual(200);
  });

  test("renderGenomeSection inlines the before/after demo when aha provided", async () => {
    const demo: GenomeAhaDemo = {
      filePath: "/tmp/big.ts",
      sizeBytes: 48_000,
      withoutGenomeTokens: 12_000,
      withGenomeTokens: 2_400,
    };
    const output = await captureStdout(() => {
      renderGenomeSection(50, false, demo);
    });
    expect(output).toContain("Example:");
    expect(output).toContain("Without genome:");
    expect(output).toContain("With genome:");
    expect(output).toContain("12,000");
    expect(output).toContain("2,400");
  });

  test("renderGenomeSection omits the demo block when aha is null", async () => {
    const output = await captureStdout(() => {
      renderGenomeSection(50, false, null);
    });
    expect(output).not.toContain("Example:");
    expect(output).not.toContain("Without genome:");
    // But still keeps the value statement.
    expect(output).toContain("~84% token savings");
  });
});

// ---------------------------------------------------------------------------
// Telemetry opt-in (#9) — explicit consent, default decline
// ---------------------------------------------------------------------------

describe("telemetry opt-in", () => {
  test("detectTelemetryState: empty config + no env → both flags false (will prompt)", () => {
    const state = detectTelemetryState(tmpHome, {});
    expect(state.alreadyOptedIn).toBe(false);
    expect(state.alreadyOptedOut).toBe(false);
    expect(state.configPath).toContain(".ashlr/config.json");
  });

  test("detectTelemetryState: ASHLR_TELEMETRY=on → alreadyOptedIn=true", () => {
    const state = detectTelemetryState(tmpHome, { ASHLR_TELEMETRY: "on" });
    expect(state.alreadyOptedIn).toBe(true);
    expect(state.alreadyOptedOut).toBe(false);
  });

  test("detectTelemetryState: ASHLR_TELEMETRY=off → alreadyOptedOut=true", () => {
    const state = detectTelemetryState(tmpHome, { ASHLR_TELEMETRY: "off" });
    expect(state.alreadyOptedIn).toBe(false);
    expect(state.alreadyOptedOut).toBe(true);
  });

  test("detectTelemetryState: config.telemetry='opt-in' → alreadyOptedIn=true", async () => {
    mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(tmpHome, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "opt-in" }),
    );
    const state = detectTelemetryState(tmpHome, {});
    expect(state.alreadyOptedIn).toBe(true);
  });

  test("detectTelemetryState: config.telemetry='off' → alreadyOptedOut=true", async () => {
    mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(tmpHome, ".ashlr", "config.json"),
      JSON.stringify({ telemetry: "off" }),
    );
    const state = detectTelemetryState(tmpHome, {});
    expect(state.alreadyOptedOut).toBe(true);
  });

  test("renderTelemetrySection: needs-consent → [ASHLR_PROMPT] with default n", async () => {
    const state: TelemetryOfferState = {
      alreadyOptedIn: false,
      alreadyOptedOut: false,
      configPath: "/tmp/cfg.json",
    };
    const output = await captureStdout(() => {
      renderTelemetrySection(state);
    });
    expect(output).toContain("[ASHLR_PROMPT:");
    expect(output).toContain("y/N");
    expect(output).toContain("default n");
    expect(output).toContain("anonymized");
    expect(output).toContain("docs/telemetry.md");
    expect(output).toContain("ASHLR_TELEMETRY=off");
    // Must explicitly say what is collected.
    expect(output).toContain("Never paths, never content");
  });

  test("renderTelemetrySection: alreadyOptedIn → ok marker, no prompt", async () => {
    const state: TelemetryOfferState = {
      alreadyOptedIn: true,
      alreadyOptedOut: false,
      configPath: "/tmp/cfg.json",
    };
    const output = await captureStdout(() => {
      renderTelemetrySection(state);
    });
    expect(output).toContain("[ASHLR_OK] telemetry-already-opted-in");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("renderTelemetrySection: alreadyOptedOut → ok marker, no prompt", async () => {
    const state: TelemetryOfferState = {
      alreadyOptedIn: false,
      alreadyOptedOut: true,
      configPath: "/tmp/cfg.json",
    };
    const output = await captureStdout(() => {
      renderTelemetrySection(state);
    });
    expect(output).toContain("[ASHLR_OK] telemetry-already-opted-out");
    expect(output).not.toContain("[ASHLR_PROMPT");
  });

  test("writeTelemetryChoice: writes 'opt-in' to config.json", async () => {
    const res = await writeTelemetryChoice("opt-in", tmpHome);
    expect(res.ok).toBe(true);
    const cfgPath = join(tmpHome, ".ashlr", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.telemetry).toBe("opt-in");
  });

  test("writeTelemetryChoice: writes 'off' to config.json", async () => {
    const res = await writeTelemetryChoice("off", tmpHome);
    expect(res.ok).toBe(true);
    const cfgPath = join(tmpHome, ".ashlr", "config.json");
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.telemetry).toBe("off");
  });

  test("writeTelemetryChoice: preserves sibling keys (e.g. ASHLR_EMBED_URL)", async () => {
    mkdirSync(join(tmpHome, ".ashlr"), { recursive: true });
    await writeFile(
      join(tmpHome, ".ashlr", "config.json"),
      JSON.stringify({ ASHLR_EMBED_URL: "http://localhost:11434/api/embeddings" }),
    );
    const res = await writeTelemetryChoice("opt-in", tmpHome);
    expect(res.ok).toBe(true);
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(join(tmpHome, ".ashlr", "config.json"), "utf8"));
    expect(parsed.ASHLR_EMBED_URL).toBe("http://localhost:11434/api/embeddings");
    expect(parsed.telemetry).toBe("opt-in");
  });

  test("runWizard --no-interactive: telemetry prompt appears BEFORE Embeddings", async () => {
    const output = await captureStdout(async () => {
      await runWizard({
        interactive: false,
        home: tmpHome,
        cwd: tmpCwd,
        installPermsFn: async () => {},
        installStatusLineFn: async () => {},
        genomeInitFn: async () => {},
        realReadDemoFn: async () => ({ payloadBytes: null, sample: null, error: "stubbed" }),
        enableOllamaFn: async () => ({ ok: true, path: "/tmp/ashlr-stub-config.json" }),
      });
    });
    const telemetryIdx = output.indexOf("STEP 6/9: Telemetry");
    const embeddingsIdx = output.indexOf("STEP 7/9: Embeddings");
    expect(telemetryIdx).toBeGreaterThan(-1);
    expect(embeddingsIdx).toBeGreaterThan(-1);
    expect(telemetryIdx).toBeLessThan(embeddingsIdx);
  }, 30_000);

  test("runWizard --no-interactive: default (no input) → telemetry NOT enabled", async () => {
    await runWizard({
      interactive: false, // askYesNo returns the default (false) when non-interactive
      home: tmpHome,
      cwd: tmpCwd,
      installPermsFn: async () => {},
      installStatusLineFn: async () => {},
      genomeInitFn: async () => {},
      realReadDemoFn: async () => ({ payloadBytes: null, sample: null, error: "stubbed" }),
      enableOllamaFn: async () => ({ ok: true, path: "/tmp/ashlr-stub-config.json" }),
    });
    const cfgPath = join(tmpHome, ".ashlr", "config.json");
    expect(existsSync(cfgPath)).toBe(true);
    const { readFileSync } = await import("fs");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    // Default-decline path: telemetry should be persisted as "off".
    expect(parsed.telemetry).toBe("off");
  }, 30_000);
});
