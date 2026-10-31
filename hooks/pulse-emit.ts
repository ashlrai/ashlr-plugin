#!/usr/bin/env bun
/**
 * pulse-emit.ts — opt-in Pulse emitter.
 *
 * When `ASHLR_PULSE_OTLP_ENDPOINT` is set, fires one OTLP/HTTP-JSON span
 * per tool call to a Pulse server (the repo next door, `ashlrai/ashlr-pulse`).
 * When it's unset, the hook is a 1-ms exit — the plugin's zero-telemetry-by-
 * default posture is preserved. There is no implicit "cloud" path; users who
 * want shared visibility point at their own pulse server.
 *
 * Privacy
 *   - No prompts, completions, cwd paths, or tool input contents are sent.
 *   - The cwd is hashed (`claude.project.hash`); repo name + branch are sent
 *     as plain strings because those are already on the user's remote.
 *   - Token counts are NULL at the plugin layer — provider token usage lives
 *     in the LLM response, which the plugin doesn't see. Pulse correctly
 *     maps these to NULL columns.
 *
 * Kill switches / env
 *   - `ASHLR_PULSE_OTLP_ENDPOINT`  — set to `http://host/api/otlp/v1/traces`
 *   - `ASHLR_PULSE_PAT`            — Bearer PAT minted on the Pulse server.
 *                                    When set, takes precedence over the
 *                                    x-ashlr-user dev fallback. Required for
 *                                    production servers (NODE_ENV=production
 *                                    rejects the dev header).
 *   - `ASHLR_PULSE_USER`           — overrides the `x-ashlr-user` header (dev only)
 *   - `ASHLR_PULSE_TIMEOUT_MS`     — per-POST timeout (default 1500)
 *
 * Hook contract: PostToolUse receives tool_name / tool_input / tool_result on
 * stdin as JSON. We never exit non-zero; the hook is fail-open.
 */

import { createHash } from "crypto";
import { spawnSync } from "child_process";

const ENDPOINT = process.env.ASHLR_PULSE_OTLP_ENDPOINT;
if (!ENDPOINT) process.exit(0);

const TIMEOUT_MS = Number(process.env.ASHLR_PULSE_TIMEOUT_MS ?? "1500");
const USER = process.env.ASHLR_PULSE_USER ?? process.env.USER ?? "dev-local";
const PAT = process.env.ASHLR_PULSE_PAT;

function size(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return Buffer.byteLength(v, "utf-8");
  try { return Buffer.byteLength(JSON.stringify(v), "utf-8"); } catch { return 0; }
}

// git probes are best-effort; keep the budget generous enough that a burst of
// parallel hook children (issue #138) doesn't silently drop repo/branch, but
// still bounded so a wedged git cannot stall the agent.
const GIT_PROBE_TIMEOUT_MS = 1_500;
const GIT_PROBE_ATTEMPTS = 3;

// Under a burst of parallel hook children, spawnSync intermittently reports
// exit 0 while losing the child's captured stdout entirely (the lost-pipe /
// lost-exit class tracked for the test harness, oven-sh/bun#34069). Both
// probes here must print at least one byte on success, so an empty success —
// or a spawn that reports no status at all — is a lost capture, not an
// answer; retry a few times. A genuine non-zero exit is definitive.
function gitProbe(args: string[], cwd: string): string | null {
  for (let attempt = 0; attempt < GIT_PROBE_ATTEMPTS; attempt++) {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    if (r.status === 0) {
      const out = r.stdout.trim();
      if (out) return out;
      continue;
    }
    // Non-zero exit is definitive; a kill signal means the timeout fired —
    // retrying a wedged git just multiplies the stall. Only a statusless,
    // signal-less spawn error (e.g. transient EAGAIN under load) retries.
    if (r.status != null || r.signal) return null;
  }
  return null;
}

function gitInfo(cwd: string): { repo: string | null; branch: string | null } {
  try {
    const br = gitProbe(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const url = gitProbe(["config", "--get", "remote.origin.url"], cwd);
    let repo: string | null = null;
    if (url) {
      // Extract owner/name from either https://host/owner/name(.git) or git@host:owner/name(.git)
      const m = url.match(/[:\/]([^:\/]+\/[^:\/]+?)(?:\.git)?$/);
      if (m) repo = m[1] ?? null;
    }
    return { repo, branch: br };
  } catch {
    return { repo: null, branch: null };
  }
}

function sessionId(): string {
  const explicit = process.env.CLAUDE_SESSION_ID;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const seed = `${process.cwd()}:${process.ppid ?? "?"}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

function nowUnixNano(): string {
  // hrtime.bigint() is process-local; map via wall clock + high-res offset so
  // Pulse can sort across processes. OTLP accepts the int-as-string form.
  return String(BigInt(Date.now()) * 1_000_000n);
}

interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  tool_response?: unknown;
}

function buildPayload(input: HookInput): unknown {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "unknown";
  const inBytes = size(input.tool_input);
  const outBytes = size(input.tool_result ?? input.tool_response);
  const cwd = process.cwd();
  const projectHash = createHash("sha256").update(cwd).digest("hex");
  const { repo, branch } = gitInfo(cwd);
  const sid = sessionId();
  const ts = nowUnixNano();

  const attributes: Array<{ key: string; value: Record<string, unknown> }> = [
    // GenAI marker — Pulse's spanToActivityEvent requires at least one of
    // gen_ai.system or a claude.* attribute.
    { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
    { key: "claude.session.id",          value: { stringValue: sid } },
    { key: "claude.tool.calls_count",    value: { intValue: "1" } },
    { key: "claude.tool.calls_types",    value: { stringValue: tool } },
    { key: "claude.project.hash",        value: { stringValue: projectHash } },
    { key: "claude.tool.input_bytes",    value: { intValue: String(inBytes) } },
    { key: "claude.tool.output_bytes",   value: { intValue: String(outBytes) } },
  ];
  if (repo)   attributes.push({ key: "claude.repo.name",   value: { stringValue: repo } });
  if (branch) attributes.push({ key: "claude.git.branch",  value: { stringValue: branch } });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name",     value: { stringValue: "ashlr-plugin" } },
            { key: "service.instance", value: { stringValue: sid } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "ashlr-plugin", version: "1" },
            spans: [
              {
                name: `tool.${tool}`,
                startTimeUnixNano: ts,
                endTimeUnixNano:   ts,
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postOtlp(payload: unknown): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // PAT (Bearer) takes precedence — required for production Pulse
    // servers. Falls back to the x-ashlr-user dev header for local-only
    // setups. Only one auth header is sent so the server's auth path
    // stays unambiguous.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (PAT) headers["authorization"] = `Bearer ${PAT}`;
    else headers["x-ashlr-user"] = USER;

    await fetch(ENDPOINT as string, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    // best-effort — never surface to the agent, but leave a stderr trace so
    // production failures can be grepped.
    process.stderr.write("[ashlr-pulse-emit] OTLP POST failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
  } finally {
    clearTimeout(t);
  }
}

// Drain stdin (hook input JSON), build payload, POST, exit 0.
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", async () => {
  let input: HookInput = {};
  try {
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) input = JSON.parse(raw) as HookInput;
  } catch (e) {
    // best-effort — leave a stderr trace.
    process.stderr.write("[ashlr-pulse-emit] stdin parse failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
  }

  try {
    const payload = buildPayload(input);
    await postOtlp(payload);
  } catch (e) {
    // never block, but leave a stderr trace.
    process.stderr.write("[ashlr-pulse-emit] payload build/post failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
  }
  process.exit(0);
});
