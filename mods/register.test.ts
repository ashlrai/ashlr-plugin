import { afterEach, describe, expect, test } from "bun:test";
import { UNAVAILABLE } from "./register.ts";
import type { Host, On, Step, Spawn } from "./host.ts";

type Callback = (...args: any[]) => any;
type Entry = { event: string; matcher?: Record<string, string>; callback: Callback };
const STEP: Step = { turnId: "turn-1", index: 3, model: "sonnet", messageCount: 7, agentId: "child-1" };
const SPAWN: Spawn = { prompt: "private task", description: "inspect", subagentType: "Explore", parentModel: "sonnet", fork: false };
const originalH = (globalThis as any).h;
afterEach(() => { if (originalH === undefined) delete (globalThis as any).h; else (globalThis as any).h = originalH; });

let fixtureId = 0;
async function fixture(options: { version?: string; fail?: string; placement?: boolean; route?: string } = {}) {
  const entries: Entry[] = [];
  const catches = new Map<string, Callback>();
  const calls: Array<{ argv: readonly string[]; stdin?: string; timeoutMs?: number }> = [];
  const commands: Array<{ name: string }> = [];
  const opened: unknown[] = [];
  const logs: string[] = [];
  const timers: Array<{ ms: number; fn: () => Promise<void>; cancelled: boolean }> = [];
  let nextCalls = 0;
  let invalidations = 0;
  const on = ((event: string, second: Callback | Record<string, string>, third?: Callback) => {
    const entry = typeof second === "function" ? { event, callback: second } : { event, matcher: second, callback: third! };
    entries.push(entry);
    return { catch(callback: Callback) { catches.set(event, callback); } };
  }) as On;
  let runner: Host["process"]["run"] = async (argv) => {
    if (options.fail && argv.includes(options.fail)) throw new Error("private diagnostic must not escape");
    if (argv[0] === "claude") return { exitCode: 0, stdout: options.version ?? "2.1.309 (Claude Code)", stderr: "" };
    if (argv.includes("select")) return { exitCode: 0, stdout: JSON.stringify({ model: options.route ?? "opus" }), stderr: "" };
    if (argv.includes("top")) return { exitCode: 0, stdout: JSON.stringify({ workers: [{ id: "worker-1", state: "ready" }] }), stderr: "" };
    if (argv.includes("list")) return { exitCode: 0, stdout: JSON.stringify({ peers: [{ session_id: "peer-1", engine_id: "claude", task: "Review\u001b[31m code" }] }), stderr: "" };
    if (argv.includes("send")) return { exitCode: 0, stdout: JSON.stringify({ delivered: true, to: "peer-1" }), stderr: "" };
    throw new Error("Unexpected host command");
  };
  const host: Host = {
    process: { run: async (argv, init) => { calls.push({ argv, ...init }); return runner(argv, init); } },
    command: { register: async spec => { commands.push(spec); } },
    clock: { every: (ms, fn) => { const timer = { ms, fn, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; } },
    ui: {
      open: async spec => { opened.push(spec); return { isPlaced: options.placement ?? true }; },
      invalidate: async () => { invalidations++; }, log: async text => { logs.push(text); },
      resolve: () => ({ Box: "Box", Text: "Text" }),
    },
  };
  const { register } = await import(`./register.ts?fixture=${++fixtureId}`);
  register(on);
  const hook = (event: string, match?: string) => {
    const entry = entries.find(item => item.event === event && (match === undefined || Object.values(item.matcher ?? {}).includes(match)));
    if (!entry) throw new Error(`Missing ${event} ${match ?? ""}`);
    return entry.callback;
  };
  const next = async (event: unknown) => { nextCalls++; return { core: event }; };
  const command = (name: string, args = "", origin = "composer") => hook("command.run", name)(host, { command: name, args, origin: { kind: origin } }, next);
  const prompt = (fullscreen = true) => hook("ui.render", "PromptHint")(host, { component: "PromptHint", viewport: { isFullscreen: fullscreen }, props: {} }, next);
  return { host, hook, next, calls, commands, opened, logs, timers, command, prompt, catches,
    setRunner: (value: typeof runner) => { runner = value; },
    nextCalls: () => nextCalls, invalidations: () => invalidations };
}

async function drain(generator: AsyncGenerator<unknown, unknown>) {
  const chunks: unknown[] = [];
  for (;;) { const part = await generator.next(); if (part.done) return { chunks, result: part.value }; chunks.push(part.value); }
}

describe("Phantom Claude function hook integration", () => {
  test("registers native commands and probes the version once per activation", async () => {
    const f = await fixture();
    await f.hook("session.start")(f.host, { cwd: "/workspace" }, f.next);
    expect(f.commands.map(c => c.name)).toEqual(["top", "peers", "send"]);
    await f.command("peers"); await f.command("peers");
    expect(f.calls.filter(c => c.argv[0] === "claude")).toHaveLength(1);
    expect(f.nextCalls()).toBe(1);
  });

  for (const version of ["2.1.308", "2.1.309-beta.1", "unrecognized"]) test(`fails closed on unsupported version ${version}`, async () => {
    const f = await fixture({ version });
    const checked = await f.hook("tool.check")(f.host, { tool: "Read", input: {} }, f.next);
    expect(checked).toEqual({ decision: "deny", decider: "person", reason: UNAVAILABLE });
    expect(await f.hook("agent.spawn")(f.host, SPAWN, f.next)).toEqual({ deny: UNAVAILABLE });
    const routed = await drain(f.hook("turn.step")(f.host, STEP, () => { throw new Error("must not reach model"); }));
    expect(routed.chunks).toEqual([{ kind: "text", index: 0, text: UNAVAILABLE }, { kind: "stop", stopReason: null, usage: null }]);
    expect(routed.result).toMatchObject({ turnId: STEP.turnId, index: STEP.index, toolUses: [], answer: UNAVAILABLE });
    expect(await f.command("peers")).toEqual({ text: UNAVAILABLE });
    expect(f.calls.every(c => c.argv[0] === "claude")).toBe(true);
    expect(f.nextCalls()).toBe(0);
  });

  test("version probe errors are denied without exposing child diagnostics", async () => {
    const f = await fixture({ fail: "claude" });
    expect(await f.hook("tool.check")(f.host, { tool: "Bash", input: { command: "ls" } }, f.next)).toMatchObject({ decision: "deny", reason: UNAVAILABLE });
    expect(f.nextCalls()).toBe(0);
  });

  test("turn router rewrites only model and preserves every streamed chunk and final result", async () => {
    const f = await fixture(); const chunks = [{ type: "thinking", text: "thought" }, { type: "text", text: "answer" }, { type: "tool", name: "Read" }];
    const final = { turnId: "turn-1", index: 3, answer: "done", toolUses: [{ id: "tool-1" }], usage: { output_tokens: 12 } };
    let received: unknown;
    const routed = await drain(f.hook("turn.step")(f.host, STEP, async function* (event: unknown) { received = event; yield* chunks; return final; }));
    expect(received).toEqual({ ...STEP, model: "opus" });
    expect(routed.chunks).toEqual(chunks); expect(routed.result).toBe(final);
    const request = f.calls.find(c => c.argv.includes("select"))!;
    expect(request.argv).toEqual(["locus", "exec", "--no-resolve", "--", "phm", "router", "select", "--json"]);
    expect(JSON.parse(request.stdin!)).toEqual({ event: "turn.step", ...STEP });
  });

  test("router failures stop turn dispatch without falling back to an ungoverned model", async () => {
    const f = await fixture({ fail: "select" });
    const result = await drain(f.hook("turn.step")(f.host, STEP, () => { throw new Error("must not reach model"); }));
    expect(result.chunks[0]).toMatchObject({ kind: "text", text: UNAVAILABLE }); expect(result.result).toMatchObject({ answer: UNAVAILABLE });
  });

  test("subagent router preserves spawn identity and never forwards private prompts", async () => {
    const f = await fixture(); const spawn = { ...SPAWN, tool_use_id: "spawn-1", provider: { plugin: "engine", tier: "core" }, background: false };
    const result = await f.hook("agent.spawn")(f.host, spawn, f.next);
    expect(result).toEqual({ core: { ...spawn, model: "opus" } });
    const request = f.calls.find(c => c.argv.includes("select"))!;
    expect(JSON.parse(request.stdin!)).toEqual({ event: "agent.spawn", model: "sonnet", subagentType: "Explore", fork: false });
    expect(request.stdin).not.toContain("private task");
  });

  test("forks refuse conflicting routes and admit routes equal to the inherited model", async () => {
    const f = await fixture();
    expect(await f.hook("agent.spawn")(f.host, { ...SPAWN, fork: true }, f.next)).toMatchObject({ deny: expect.stringContaining("non-fork") });
    expect(f.nextCalls()).toBe(0);
    const same = await fixture({ route: "sonnet" });
    expect(await same.hook("agent.spawn")(same.host, { ...SPAWN, fork: true }, same.next)).toEqual({ core: { ...SPAWN, fork: true, model: "sonnet" } });
  });

  test("tool checks retain core read decisions and never auto-allow opaque execution", async () => {
    const f = await fixture(); const read = { tool: "Read", input: { file_path: "README.md" } };
    expect(await f.hook("tool.check")(f.host, read, f.next)).toEqual({ core: read });
    expect(await f.hook("tool.check")(f.host, { tool: "Bash", input: { command: "git push --force" } }, f.next)).toMatchObject({ decision: "deny", decider: "person" });
    expect(await f.hook("tool.check")(f.host, { tool: "Bash", input: { command: "bash scripts/publish.sh" } }, f.next)).toMatchObject({ decision: "ask", decider: "person" });
    expect(await f.hook("tool.check")(f.host, { tool: "mcp__unknown__execute", input: {} }, f.next)).toMatchObject({ decision: "ask", decider: "person" });
    expect(f.nextCalls()).toBe(3);
  });

  test("person review never weakens an existing host deny and policy errors fail closed", async () => {
    const f = await fixture();
    const inherited = { decision: "deny", reason: "Managed policy forbids execution." };
    expect(await f.hook("tool.check")(f.host, { tool: "Bash", input: { command: "git status" } }, async () => inherited)).toBe(inherited);
    expect(await f.hook("tool.check")(f.host, { tool: "Bash", input: { command: "git status" } }, async () => { throw new Error("private policy error"); }))
      .toEqual({ decision: "deny", decider: "person", reason: UNAVAILABLE });
  });

  test("native peer commands sanitize labels and send message as stdin after registry validation", async () => {
    const f = await fixture();
    expect(await f.command("peers")).toEqual({ text: "peer-1 · claude · Review code" });
    expect(await f.command("send", "peer-1 text $(not-a-shell) --flag")).toEqual({ text: "Delivered to peer-1." });
    const sent = f.calls.find(c => c.argv.includes("send"))!;
    expect(sent.argv).toEqual(["locus", "peers", "send", "--json"]);
    expect(JSON.parse(sent.stdin!)).toEqual({ to: "peer-1", message: "text $(not-a-shell) --flag" });
  });

  test("only the person's composer can authorize /send", async () => {
    const f = await fixture();
    for (const origin of ["plugin", "sdk", "bridge", "suggestion"]) expect(await f.command("send", "peer-1 hello", origin)).toEqual({ text: "Enter /send yourself to authorize a peer message." });
    expect(f.calls).toHaveLength(0);
  });

  test("unknown peers and transport errors produce no false delivery claims or retries", async () => {
    const f = await fixture();
    expect((await f.command("send", "absent hello")).text).toContain("unconfirmed");
    expect(f.calls.some(c => c.argv.includes("send"))).toBe(false);
    const failed = await fixture({ fail: "send" });
    expect((await failed.command("send", "peer-1 hello")).text).toContain("unconfirmed");
    expect(failed.calls.filter(c => c.argv.includes("send"))).toHaveLength(1);
  });

  test("opens automatically only in fullscreen and avoids duplicate pane timers", async () => {
    const f = await fixture(); await f.prompt(false);
    expect(f.opened).toHaveLength(0);
    await Promise.all([f.prompt(), f.prompt()]);
    expect(f.opened).toEqual([{ id: "phantom-top", title: "Phantom fleet", columns: 44, rows: 14 }]);
    expect(f.timers).toHaveLength(1); expect(f.timers[0]!.ms).toBe(3000);
  });

  test("pane respects available body width and rows and delegates other pane instances", async () => {
    const f = await fixture(); await f.command("top");
    (globalThis as any).h = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });
    const event = { component: "Pane", requestId: "phantom-top", props: { bodyColumns: 18, scroll: { bodyRows: 2 } } };
    const tree = await f.hook("ui.render", "Pane")(f.host, event, f.next);
    expect(tree.type).toBe("Box"); expect(tree.props).toEqual({ flexDirection: "column", width: 18 });
    expect(tree.children).toHaveLength(2);
    expect(tree.children.every((c: any) => c.type === "Text" && c.props.wrap === "truncate-end")).toBe(true);
    const other = { ...event, requestId: "someone-else" };
    expect(await f.hook("ui.render", "Pane")(f.host, other, f.next)).toEqual({ core: other });
  });

  test("close cancels polling, prevents auto-reopen, and /top deliberately reopens", async () => {
    const f = await fixture(); await f.prompt();
    await f.hook("ui.close")(f.host, { id: "phantom-top" }, f.next);
    expect(f.timers[0]!.cancelled).toBe(true);
    await f.prompt(); expect(f.opened).toHaveLength(1);
    await f.command("top"); expect(f.opened).toHaveLength(2); expect(f.timers).toHaveLength(2);
    await f.hook("session.end")(f.host, {}, f.next);
    expect(f.timers[1]!.cancelled).toBe(true);
  });

  test("refused pane placement does not start polling", async () => {
    const f = await fixture({ placement: false });
    expect(await f.command("top")).toEqual({ text: "Pane unavailable on this surface." });
    expect(f.timers).toHaveLength(0); expect(f.calls.some(c => c.argv.includes("top"))).toBe(false);
  });

  test("hard gate catch handlers deny when the engine skips a failed hook", async () => {
    const f = await fixture();
    expect(await f.catches.get("tool.check")!(f.host, { tool: "Bash", input: {} }, f.next)).toMatchObject({ decision: "deny", decider: "person" });
    expect(await f.catches.get("agent.spawn")!(f.host, SPAWN, f.next)).toEqual({ deny: UNAVAILABLE });
    const step = await drain(f.catches.get("turn.step")!(f.host, STEP, f.next));
    expect(step.chunks[0]).toMatchObject({ kind: "text", text: UNAVAILABLE }); expect(step.result).toMatchObject({ answer: UNAVAILABLE });
    expect(f.nextCalls()).toBe(0);
  });

  test("closing while the first snapshot is pending cannot leave an orphan polling timer", async () => {
    const f = await fixture();
    await f.command("peers");
    let release!: () => void;
    f.setRunner(async () => { await new Promise<void>(resolve => { release = resolve; }); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const opening = f.command("top");
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    await f.hook("ui.close")(f.host, { id: "phantom-top" }, f.next);
    release(); await opening;
    expect(f.timers).toHaveLength(0);
  });

  for (const event of ["ui.close", "session.end"]) test(`late pane placement after ${event} cannot restart polling`, async () => {
    const f = await fixture(); await f.command("peers");
    let release!: () => void;
    f.host.ui.open = async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { isPlaced: true };
    };
    const opening = f.command("top");
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    await f.hook(event)(f.host, { id: "phantom-top" }, f.next);
    release(); await opening;
    expect(f.timers).toHaveLength(0);
    expect(f.calls.some(c => c.argv.includes("top"))).toBe(false);
  });

  test("a superseded snapshot cannot overwrite a reopened pane", async () => {
    const f = await fixture(); await f.command("peers");
    let release!: () => void;
    f.setRunner(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { exitCode: 0, stdout: '{"snapshot":"obsolete"}', stderr: "" };
    });
    const first = f.command("top");
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    await f.hook("ui.close")(f.host, { id: "phantom-top" }, f.next);
    f.setRunner(async () => ({ exitCode: 0, stdout: '{"snapshot":"fresh"}', stderr: "" }));
    await f.command("top");
    release(); await first;
    expect(f.invalidations()).toBe(0);
    await f.timers[0]!.fn();
    (globalThis as any).h = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });
    const tree = await f.hook("ui.render", "Pane")(f.host, { requestId: "phantom-top", props: {} }, f.next);
    expect(JSON.stringify(tree)).toContain("fresh");
    expect(JSON.stringify(tree)).not.toContain("obsolete");
    expect(f.invalidations()).toBe(1);
  });

  test("session end clears cached version admission before subsequent dispatch", async () => {
    const f = await fixture(); await f.command("peers");
    await f.hook("session.end")(f.host, {}, f.next);
    f.setRunner(async () => ({ exitCode: 0, stdout: "2.1.308 (Claude Code)", stderr: "" }));
    expect(await f.hook("tool.check")(f.host, { tool: "Read", input: {} }, f.next)).toMatchObject({ decision: "deny" });
    expect(f.calls.filter(c => c.argv[0] === "claude")).toHaveLength(2);
  });

  test("polling coalesces overlapping refreshes and catches unavailable fleet data", async () => {
    const f = await fixture(); await f.command("top");
    let release!: () => void;
    f.setRunner(async () => { await new Promise<void>(resolve => { release = resolve; }); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const first = f.timers[0]!.fn();
    const second = f.timers[0]!.fn();
    await second;
    expect(f.calls.filter(c => c.argv.includes("top"))).toHaveLength(2);
    release(); await first;
    f.setRunner(async () => { throw new Error("secret diagnostic"); });
    await f.timers[0]!.fn();
    expect(f.invalidations()).toBe(3);
  });
});
