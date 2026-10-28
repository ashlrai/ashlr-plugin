import { describe, expect, test } from "bun:test";
import { parseSend, peers, plain, requireVersion, routeModel, send, supportedVersion, top } from "./register.ts";
import type { ProcessHost, Step } from "./host.ts";

const step: Step = { turnId: "turn-a", index: 2, model: "sonnet", messageCount: 4 };
const listed = { peers: [{ session_id: "review-a", engine_id: "codex", task: "Review parser" }] };
function stub(response: unknown, exitCode = 0) {
  const calls: { argv: readonly string[]; init: unknown }[] = [];
  const host: ProcessHost = { process: { async run(argv, init) {
    calls.push({ argv, init });
    return { exitCode, stdout: typeof response === "string" ? response : JSON.stringify(response), stderr: "child diagnostic withheld" };
  } } };
  return { host, calls };
}

describe("version admission", () => {
  for (const version of ["2.1.309", "2.1.309 (Claude Code)\n", "2.1.310", "2.2.0", "3.0.0"]) {
    test(`accepts ${version.trim()}`, () => expect(supportedVersion(version)).toBe(true));
  }
  for (const version of ["2.1.280", "2.1.308", "2.0.999", "1.99.999", "", "2.1.309-beta", "v2.1.309", "2.1.309 extra", "garbage\n2.1.309"]) {
    test(`refuses ${JSON.stringify(version)}`, () => expect(supportedVersion(version)).toBe(false));
  }
  test("bounds the host probe and rejects failed probes even with valid stdout", async () => {
    const { host, calls } = stub("2.1.309 (Claude Code)", 1);
    await expect(requireVersion(host)).rejects.toThrow("Requires Claude Code");
    expect(calls).toEqual([{ argv: ["claude", "--version"], init: { timeoutMs: 2000 } }]);
  });
});

describe("Phantom argv adapters", () => {
  test("routes using Locus without credential resolution; never includes task prompts", async () => {
    const { host, calls } = stub({ model: "claude-sonnet-4-6" });
    expect(await routeModel(host, "turn.step", step)).toBe("claude-sonnet-4-6");
    expect(calls).toEqual([{
      argv: ["locus", "exec", "--no-resolve", "--", "phm", "router", "select", "--json"],
      init: { timeoutMs: 2000, stdin: JSON.stringify({ event: "turn.step", model: "sonnet", turnId: "turn-a", index: 2, messageCount: 4 }) },
    }]);
  });
  for (const response of [null, [], {}, { model: "" }, { model: "--flag" }, { model: "a\ncommand" }, { model: 4 }, { ok: false, model: "sonnet" }, "not json", "x".repeat(65537)]) {
    test(`rejects invalid route result ${JSON.stringify(response).slice(0, 60)}`, async () => {
      await expect(routeModel(stub(response).host, "turn.step", step)).rejects.toThrow();
    });
  }
  test("does not leak child diagnostics into errors", async () => {
    const { host } = stub("private child output", 1);
    await expect(top(host)).rejects.toThrow("Phantom bridge unavailable");
    try { await top(host); } catch (error) {
      expect(String(error)).not.toContain("private child output");
      expect(String(error)).not.toContain("child diagnostic");
    }
  });
  test("bounds snapshot lines without inventing schema fields", async () => {
    const { host, calls } = stub({ agents: Array.from({ length: 300 }, (_, i) => ({ id: i })) });
    const lines = await top(host);
    expect(lines.length).toBe(200);
    expect(lines.join("\n")).toContain('"agents"');
    expect(calls[0]?.argv).toEqual(["locus", "exec", "--no-resolve", "--", "phm", "top", "--json"]);
  });
});

describe("Locus peers", () => {
  test("accepts the existing peer registry envelope and removes display controls", async () => {
    const { host, calls } = stub({ schema: "locus.peers.v1", peers: [{ ...listed.peers[0], task: "\x1b[31mReview\u202eflow\nnow" }] });
    const rows = await peers(host);
    expect(rows[0]?.task).toBe("Review flow now");
    expect(calls[0]?.argv).toEqual(["locus", "peers", "list", "--json"]);
    expect(await peers(stub({ peers: [] }).host)).toEqual([]);
  });
  for (const response of [ {}, { peers: null }, { peers: [null] }, { peers: [{ session_id: "peer\nspoof", engine_id: "codex", task: "x" }] }, { peers: [listed.peers[0], listed.peers[0]] }, { peers: Array(257).fill(listed.peers[0]) }, { peers: [{ ...listed.peers[0], task: 5 }] } ]) {
    test(`rejects malformed/ambiguous inventory ${JSON.stringify(response).slice(0, 65)}`, async () => {
      await expect(peers(stub(response).host)).rejects.toThrow();
    });
  }
  test("message is opaque stdin JSON, with matching delivery receipt", async () => {
    const calls: unknown[] = [];
    const message = '$(touch /tmp/should-not-exist); --admin "quoted"\nsecond line';
    const host: ProcessHost = { process: { async run(argv, init) {
      calls.push({ argv, init });
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(calls.length === 1 ? listed : { delivered: true, to: "review-a" }) };
    } } };
    expect(await send(host, `review-a ${message}`)).toBe("Delivered to review-a.");
    expect(calls[1]).toEqual({ argv: ["locus", "peers", "send", "--json"], init: { timeoutMs: 2000, stdin: JSON.stringify({ to: "review-a", message }) } });
  });
  test("unknown recipient never sends", async () => {
    const { host, calls } = stub(listed);
    await expect(send(host, "missing hello")).rejects.toThrow("not in the local");
    expect(calls.length).toBe(1);
  });
  for (const receipt of [{}, { delivered: true, to: "other" }, { delivered: false, to: "review-a" }]) {
    test(`rejects unconfirmed receipt ${JSON.stringify(receipt)} without retry`, async () => {
      let count = 0;
      const host: ProcessHost = { process: { async run() {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(++count === 1 ? listed : receipt) };
      } } };
      await expect(send(host, "review-a hello")).rejects.toThrow();
      expect(count).toBe(2);
    });
  }
  for (const args of ["", "review-a", "review-a  ", '"unterminated hello', `${"a".repeat(129)} hello`, '"peer\\u202e" hello', "review-a hello\0world", `review-a ${"a".repeat(8193)}`]) {
    test(`invalid send arguments ${JSON.stringify(args).slice(0, 55)}`, () => {
      expect(() => parseSend(args)).toThrow("Usage");
    });
  }
  test("message at the size boundary is accepted", () => {
    expect(parseSend(`review-a ${"a".repeat(8192)}`).message.length).toBe(8192);
  });
  test("supports opaque Locus labels, including quoted spaces, without treating them as flags", async () => {
    for (const label of ["review/a.v2", "--flag", "Review Agent", "a".repeat(128)]) {
      const { host } = stub({ peers: [{ ...listed.peers[0], session_id: label }] });
      expect((await peers(host))[0]?.session_id).toBe(label);
      expect(parseSend(`${JSON.stringify(label)} hello`)).toEqual({ to: label, message: "hello" });
    }
  });
  test("removes terminal and bidi controls", () => {
    expect(plain("\x1b[31mRED\x1b[0m\u202e\n")).toBe("RED");
  });
});
