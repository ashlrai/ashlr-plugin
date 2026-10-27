import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isTelemetryEnabled,
  logGenomeCompressionRatioEvent,
  logHookPerfEvent,
  logPreCompactionNudgeEvent,
  maybeTelemetryConsentNotice,
  recordTelemetryEvent,
  telemetryBufferPath,
  telemetryConsentStampPath,
  telemetrySessionPath,
} from "../servers/_telemetry";
import { flush } from "../scripts/telemetry-flush";

const disabledModes = [
  { name: "default (no consent)", env: "", config: {} },
  { name: "environment off overrides config opt-in", env: "off", config: { telemetry: "opt-in" } },
  { name: "environment zero overrides config opt-in", env: "0", config: { telemetry: "opt-in" } },
  { name: "normalized environment kill switch", env: " OFF ", config: { telemetry: "opt-in" } },
  { name: "config off overrides environment on", env: "on", config: { telemetry: "off" } },
  { name: "config off overrides environment one", env: "1", config: { telemetry: "off" } },
  { name: "unknown values do not grant consent", env: "unknown", config: { telemetry: "unknown" } },
];

let home: string;
let previousTelemetry: string | undefined;
const backlog = JSON.stringify({
  ts: 1, kind: "wizard_step", sessionId: "offline-test", step_name: "welcome", outcome: "completed",
}) + "\n";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ashlr-telemetry-offline-"));
  mkdirSync(join(home, ".ashlr"));
  previousTelemetry = process.env.ASHLR_TELEMETRY;
});

afterEach(() => {
  if (previousTelemetry === undefined) delete process.env.ASHLR_TELEMETRY;
  else process.env.ASHLR_TELEMETRY = previousTelemetry;
  rmSync(home, { recursive: true, force: true });
});

describe("disabled telemetry attempts zero network calls", () => {
  for (const mode of disabledModes) {
    test(mode.name, async () => {
      process.env.ASHLR_TELEMETRY = mode.env;
      writeFileSync(join(home, ".ashlr", "config.json"), JSON.stringify(mode.config));
      // Old opt-in data must not be sent after consent is withdrawn.
      writeFileSync(telemetryBufferPath(home), backlog);
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
        throw new Error("offline: network access forbidden");
      }, { preconnect: globalThis.fetch.preconnect }));
      try {
        expect(isTelemetryEnabled(home)).toBe(false);
        recordTelemetryEvent({ kind: "wizard_step", step_name: "welcome", outcome: "completed" }, home);
        logHookPerfEvent({ hook_name: "session-end", p50_ms: 1, p99_ms: 2, count: 1 }, home);
        logGenomeCompressionRatioEvent({ tool: "grep", raw_bytes: 100, compressed_bytes: 10 }, home);
        logPreCompactionNudgeEvent({ cumulativeBytes: 100, estimatedTokens: 25, pct: 1 }, home);
        expect(maybeTelemetryConsentNotice(home)).toBeNull();
        for (let i = 0; i < 2; i++) {
          expect(await flush(home)).toEqual({ ok: true, skipped: "telemetry-off" });
        }
        // Assert attempts explicitly: flush catches network exceptions.
        expect(fetchSpy).toHaveBeenCalledTimes(0);
        expect(readFileSync(telemetryBufferPath(home), "utf8")).toBe(backlog);
        expect(existsSync(telemetrySessionPath(home))).toBe(false);
        expect(existsSync(telemetryConsentStampPath(home))).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  }

  test("revoking consent takes effect on the next flush in the same process", async () => {
    process.env.ASHLR_TELEMETRY = "on";
    writeFileSync(telemetryBufferPath(home), backlog);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      expect(await flush(home)).toEqual({ ok: true, sent: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      writeFileSync(telemetryBufferPath(home), backlog);
      writeFileSync(join(home, ".ashlr", "config.json"), JSON.stringify({ telemetry: "off" }));
      expect(await flush(home)).toEqual({ ok: true, skipped: "telemetry-off" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(readFileSync(telemetryBufferPath(home), "utf8")).toBe(backlog);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

test("CLI stays offline for every disabled mode; opted-in control reaches the local collector", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json({ accepted: 1 });
    },
  });
  async function runCli(env: string, config: object) {
    writeFileSync(join(home, ".ashlr", "config.json"), JSON.stringify(config));
    writeFileSync(telemetryBufferPath(home), backlog);
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../scripts/telemetry-flush.ts")], {
      env: { ...process.env, HOME: home, ASHLR_TELEMETRY: env, ASHLR_TELEMETRY_URL: server.url.href },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(0);
    return stderr;
  }
  try {
    for (const mode of disabledModes) {
      expect(await runCli(mode.env, mode.config)).toContain("flush skipped: telemetry-off");
      expect(requests).toBe(0);
      expect(readFileSync(telemetryBufferPath(home), "utf8")).toBe(backlog);
      expect(existsSync(telemetrySessionPath(home))).toBe(false);
    }
    // Prove the same subprocess, endpoint and backlog can actually send.
    expect(await runCli("on", {})).toContain("flushed 1 events");
    expect(requests).toBe(1);
    expect(readFileSync(telemetryBufferPath(home), "utf8")).toBe("");
  } finally {
    server.stop(true);
  }
}, 15_000);
