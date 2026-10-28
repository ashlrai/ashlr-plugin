import { checkHardLimits } from "../hooks/phantom-policy.ts";
import type { Host, On, Step, StepResult, ProcessHost, Spawn } from "./host.ts";

export const MIN_CLAUDE_VERSION = "2.1.309";
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT = 2000;
export const UNAVAILABLE = `Phantom bridge unavailable. Requires Claude Code ${MIN_CLAUDE_VERSION}+, a pinned Locus binding, and compatible local Phantom/Locus commands.`;

export function supportedVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?\s*$/.exec(value.trim());
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 309)));
}

export async function requireVersion($: ProcessHost): Promise<void> {
  // This probes the host executable only. Integration commands below use Locus.
  const result = await $.process.run(["claude", "--version"], { timeoutMs: TIMEOUT });
  if (result.exitCode !== 0 || !supportedVersion(result.stdout)) throw new Error(UNAVAILABLE);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function json($: ProcessHost, argv: string[], input?: unknown): Promise<Record<string, unknown>> {
  const result = await $.process.run(argv, {
    timeoutMs: TIMEOUT,
    ...(input === undefined ? {} : { stdin: JSON.stringify(input) }),
  });
  // Never echo child diagnostics or unvalidated output: it may contain secrets.
  if (result.exitCode !== 0 || result.stdout.length > MAX_OUTPUT) throw new Error(UNAVAILABLE);
  const value: unknown = JSON.parse(result.stdout);
  if (!record(value) || value.ok === false) throw new Error(UNAVAILABLE);
  return value;
}

function phm(args: string[]): string[] {
  return ["locus", "exec", "--no-resolve", "--", "phm", ...args];
}

export async function routeModel($: ProcessHost, event: "turn.step" | "agent.spawn", e: Step | Spawn): Promise<string> {
  // Metadata only: never send the transcript, task prompt, environment, or cwd.
  const request = "turnId" in e
    ? { event, model: e.model, turnId: e.turnId, index: e.index, messageCount: e.messageCount, agentId: e.agentId }
    : { event, model: e.model ?? e.parentModel, subagentType: e.subagentType, fork: e.fork };
  const result = await json($, phm(["router", "select", "--json"]), request);
  if (typeof result.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(result.model)) throw new Error(UNAVAILABLE);
  return result.model;
}

/** Strip terminal controls, bidi overrides and invisible formatting from labels. */
export function plain(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").trimEnd();
}

export async function top($: ProcessHost): Promise<string[]> {
  const value = await json($, phm(["top", "--json"]));
  // phm owns its evolving snapshot schema; render bounded JSON without guessing
  // that a missing count means zero. Pane dimensions provide the final clipping.
  return JSON.stringify(value, null, 2).split("\n").slice(0, 200).map(plain);
}

export interface Peer { session_id: string; engine_id: string; task: string }
function peerLabel(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && new TextEncoder().encode(value).length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
export async function peers($: ProcessHost): Promise<Peer[]> {
  const value = await json($, ["locus", "peers", "list", "--json"]);
  if (!Array.isArray(value.peers) || value.peers.length > 256) throw new Error(UNAVAILABLE);
  const ids = new Set<string>();
  return value.peers.map((peer: unknown) => {
    if (!record(peer) || !peerLabel(peer.session_id)
      || typeof peer.engine_id !== "string" || typeof peer.task !== "string" || peer.task.length > 4096 || ids.has(peer.session_id)) throw new Error(UNAVAILABLE);
    ids.add(peer.session_id);
    return { session_id: peer.session_id, engine_id: plain(peer.engine_id).slice(0, 64), task: plain(peer.task).slice(0, 240) };
  });
}

export function parseSend(args: string): { to: string; message: string } {
  const text = args.trimStart();
  const match = text.startsWith('"') ? /^("(?:[^"\\]|\\.)*")\s+([\s\S]+)$/.exec(text) : /^(\S+)\s+([\s\S]+)$/.exec(text);
  const usage = 'Usage: /send PEER MESSAGE (quote peer labels containing spaces; maximum 8192 message characters).';
  if (!match) throw new Error(usage);
  let to: unknown;
  try { to = text.startsWith('"') ? JSON.parse(match[1]) : match[1]; } catch { throw new Error(usage); }
  if (!peerLabel(to) || !match[2].trim() || match[2].length > 8192 || match[2].includes("\0")) throw new Error(usage);
  return { to, message: match[2] };
}

export async function send($: ProcessHost, args: string): Promise<string> {
  const input = parseSend(args);
  if (!(await peers($)).some(peer => peer.session_id === input.to)) throw new Error("Peer is not in the local Locus registry; refresh /peers.");
  // Message travels as stdin, never shell source or command-line flags. No retry:
  // an interrupted acknowledgment cannot prove that delivery did not happen.
  const receipt = await json($, ["locus", "peers", "send", "--json"], input);
  if (receipt.delivered !== true || receipt.to !== input.to) throw new Error(UNAVAILABLE);
  return `Delivered to ${input.to}.`;
}

// Injected by Claude's function-hook sandbox, not a Node/React import.
declare function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
const PANE = "phantom-top";

function stopped(e: Step): StepResult {
  return { turnId: e.turnId, index: e.index, answer: UNAVAILABLE, toolUses: [], stopReason: null, usage: null };
}
async function* blocked(e: Step): AsyncGenerator<unknown, StepResult> {
  // A return value alone is not painted by Claude; stream the failure too.
  yield { kind: "text", index: 0, text: UNAVAILABLE };
  yield { kind: "stop", stopReason: null, usage: null };
  return stopped(e);
}

let ready: Promise<boolean> | undefined;
let opened = false;
let dismissed = false;
let snapshot = ["Loading local Phantom fleet…"];
let timer: { cancel(): void } | undefined;
let refreshing = false;
let generation = 0;
function supported($: Host): Promise<boolean> { return ready ??= requireVersion($).then(() => true, () => false); }
async function refresh($: Host): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const epoch = generation;
  let lines: string[];
  try { lines = await top($); } catch { lines = [UNAVAILABLE]; }
  finally { refreshing = false; }
  if (epoch !== generation || !opened) return;
  snapshot = lines;
  $.ui.invalidate("ui.render");
}
async function open($: Host): Promise<void> {
  const epoch = ++generation;
  timer?.cancel(); timer = undefined; opened = false;
  snapshot = ["Loading local Phantom fleet…"];
  const placed = await $.ui.open({ id: PANE, title: "Phantom fleet", columns: 44, rows: 14 });
  if (epoch !== generation) return;
  opened = placed.isPlaced;
  if (!opened) return;
  await refresh($);
  if (!opened || epoch !== generation) return;
  timer ??= $.clock.every(3000, async () => { if (opened) await refresh($); });
}

export function register(on: On): void {
  generation++;
  timer?.cancel();
  ready = undefined; opened = false; dismissed = false; timer = undefined;
  snapshot = ["Loading local Phantom fleet…"]; refreshing = false;
  on("session.start", async ($, e, next) => {
    for (const spec of [
      { name: "top", description: "Open the local Phantom fleet pane" },
      { name: "peers", description: "List local Locus peers" },
      { name: "send", description: "Send a message to a local Locus peer", argumentHint: "PEER MESSAGE" },
    ]) await $.command.register({ ...spec, immediate: true });
    if (!await supported($)) await $.ui.log(UNAVAILABLE);
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    let model: string;
    try {
      if (!await supported($)) return yield* blocked(e);
      model = await routeModel($, "turn.step", e);
    } catch { return yield* blocked(e); }
    // Keep the engine's stream and result intact, including thinking/tool chunks.
    return yield* next({ ...e, model });
  }).catch(async function* ($, e) { return yield* blocked(e); });

  on("agent.spawn", async ($, e, next) => {
    let model: string;
    try {
      if (!await supported($)) return { deny: UNAVAILABLE };
      model = await routeModel($, "agent.spawn", e);
      // Forks cannot change model in Claude. Refuse a conflicting route rather
      // than silently ignoring the router's decision.
      if (e.fork && model !== e.parentModel) return { deny: "Phantom selected a different model; use a non-fork subagent." };
    } catch { return { deny: UNAVAILABLE }; }
    return next({ ...e, model });
  }).catch(async () => ({ deny: UNAVAILABLE }));

  on("tool.check", async ($, e, next) => {
    try {
      if (!await supported($)) return { decision: "deny", decider: "person", reason: UNAVAILABLE };
      const decision = checkHardLimits(e.tool, e.input);
      if (decision?.decision === "deny") return decision;
      // A human-review floor must never turn an existing host deny into ask.
      const inherited = await next(e);
      if (inherited && typeof inherited === "object" && "decision" in inherited && inherited.decision === "deny") return inherited;
      return decision ?? inherited;
    } catch { return { decision: "deny", decider: "person", reason: UNAVAILABLE }; }
  }).catch(async () => ({ decision: "deny", decider: "person", reason: UNAVAILABLE }));

  on("command.run", { command: "top" }, async ($) => {
    try {
      if (!await supported($)) return { text: UNAVAILABLE };
      dismissed = true;
      await open($);
      return { text: opened ? "Phantom fleet pane opened." : "Pane unavailable on this surface." };
    } catch { return { text: UNAVAILABLE }; }
  });
  on("command.run", { command: "peers" }, async ($) => {
    try {
      if (!await supported($)) return { text: UNAVAILABLE };
      const rows = await peers($);
      return { text: rows.length ? rows.map(p => `${p.session_id} · ${p.engine_id} · ${p.task}`).join("\n") : "No local Locus peers registered." };
    } catch { return { text: UNAVAILABLE }; }
  });
  on("command.run", { command: "send" }, async ($, e) => {
    // A model/plugin/SDK command is not the person's authorization to message.
    if (e.origin.kind !== "composer") return { text: "Enter /send yourself to authorize a peer message." };
    try {
      if (!await supported($)) return { text: UNAVAILABLE };
      return { text: await send($, e.args) };
    } catch { return { text: "Message delivery is unconfirmed. Check /peers and the local Locus transport before retrying." }; }
  });

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    if (!opened && !dismissed && e.viewport?.isFullscreen === true) {
      // Set before the first await to prevent parallel render events reopening.
      dismissed = true;
      try { if (await supported($)) await open($); } catch { /* /top can retry. */ }
    }
    return next(e);
  });
  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const columns = Math.max(1, e.props.bodyColumns ?? 40);
    const rows = Math.max(1, e.props.scroll?.bodyRows ?? 14);
    return h(Box, { flexDirection: "column", width: columns },
      ...snapshot.slice(0, rows).map(line => h(Text, { wrap: "truncate-end" }, plain(line))));
  });
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const result = await next(e);
    if (!(result && typeof result === "object" && "deny" in result)) {
      generation++;
      opened = false; dismissed = true; timer?.cancel(); timer = undefined;
    }
    return result;
  });
  on("session.end", async ($, e, next) => {
    generation++;
    opened = false; timer?.cancel(); timer = undefined; ready = undefined;
    return next(e);
  });
}
