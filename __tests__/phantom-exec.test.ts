/**
 * phantom exec detection is value-free: names, phm prefixes and the proxy
 * host/port only. It never resolves phm: refs and never returns key values.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  describePhantomExec,
  detectPhantomExec,
  keyKind,
  providerKeyUsable,
  redactProxyUrl,
} from "../servers/_phantom-exec.ts";
import { buildReport } from "../scripts/doctor.ts";

const TOKEN = "phm_" + "a".repeat(64);
const PROXY_TOKEN = "proxytok_" + "b".repeat(32);

function session(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PHANTOM_PROXY_PORT: "54321",
    PHANTOM_PROXY_TOKEN: PROXY_TOKEN,
    PHANTOM_SESSION_KEYS: "ANTHROPIC_API_KEY",
    ANTHROPIC_API_KEY: TOKEN,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:54321/anthropic/_phantom/${PROXY_TOKEN}/`,
    ...extra,
  };
}

describe("keyKind", () => {
  test("classifies without exposing values", () => {
    expect(keyKind(undefined)).toBe("unset");
    expect(keyKind("  ")).toBe("unset");
    expect(keyKind(TOKEN)).toBe("placeholder");
    expect(keyKind("phm:ANTHROPIC_API_KEY")).toBe("ref");
    expect(keyKind("sk-ant-test")).toBe("plain");
  });
});

describe("detectPhantomExec", () => {
  test("recognises a session with a proxied placeholder and no warnings", () => {
    const r = detectPhantomExec(session());
    expect(r.inSession).toBe(true);
    expect(r.proxyPort).toBe(54321);
    expect(r.keys.ANTHROPIC_API_KEY).toBe("placeholder");
    expect(r.proxiedBaseUrls.ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:54321/anthropic/_phantom/<redacted>/",
    );
    expect(r.warnings).toEqual([]);
  });

  test("no output ever contains a key value or the proxy token", () => {
    for (const env of [
      session(),
      session({ OPENAI_API_KEY: "phm_" + "c".repeat(64) }),
      { ANTHROPIC_API_KEY: TOKEN },
      { ANTHROPIC_API_KEY: "phm:SOME_NAME" },
    ]) {
      const r = detectPhantomExec(env);
      const out = JSON.stringify(r) + describePhantomExec(r);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(PROXY_TOKEN);
      expect(out).not.toContain("c".repeat(64));
    }
  });

  test("a placeholder outside a session warns", () => {
    const r = detectPhantomExec({ ANTHROPIC_API_KEY: TOKEN });
    expect(r.inSession).toBe(false);
    expect(r.warnings.join(" ")).toContain("not a phantom exec session");
    expect(describePhantomExec(r)).toContain("not a phantom exec session");
  });

  test("a phm: ref warns and is never resolved", () => {
    const r = detectPhantomExec({ OPENAI_API_KEY: "phm:OPENAI_API_KEY" });
    expect(r.keys.OPENAI_API_KEY).toBe("ref");
    expect(r.warnings.join(" ")).toContain("does not resolve references");
  });

  test("a placeholder whose base URL is not the session proxy warns", () => {
    const r = detectPhantomExec(session({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }));
    expect(r.proxiedBaseUrls.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("does not point at this session's proxy");
  });

  test("a base URL on a different port is not treated as proxied", () => {
    const r = detectPhantomExec(session({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1/anthropic/" }));
    expect(r.proxiedBaseUrls.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("invalid port or missing proxy token is not a session", () => {
    expect(detectPhantomExec(session({ PHANTOM_PROXY_PORT: "99999" })).inSession).toBe(false);
    expect(detectPhantomExec(session({ PHANTOM_PROXY_PORT: "abc" })).inSession).toBe(false);
    expect(detectPhantomExec({ ...session(), PHANTOM_PROXY_TOKEN: "" }).inSession).toBe(false);
  });

  test("plain keys and no phantom variables: no warnings, not a session", () => {
    const r = detectPhantomExec({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(r.inSession).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(describePhantomExec(r)).toBe("not a phantom exec session");
  });
});

describe("providerKeyUsable", () => {
  test("plain key usable; proxied placeholder usable; others not", () => {
    expect(providerKeyUsable("ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
    expect(providerKeyUsable("ANTHROPIC_API_KEY", session())).toBe(true);
    expect(providerKeyUsable("ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: TOKEN })).toBe(false);
    expect(providerKeyUsable("ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "phm:X" })).toBe(false);
    expect(providerKeyUsable("ANTHROPIC_API_KEY", {})).toBe(false);
  });
});

describe("redactProxyUrl", () => {
  test("strips the session token segment only", () => {
    expect(redactProxyUrl("http://127.0.0.1:1/openai/_phantom/abc123/v1")).toBe(
      "http://127.0.0.1:1/openai/_phantom/<redacted>/v1",
    );
    expect(redactProxyUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });
});

describe("doctor phantom exec line", () => {
  async function report(env: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "ashlr-doctor-pe-"));
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "ashlr", version: "0.4.0" }));
    const home = await mkdtemp(join(tmpdir(), "ashlr-doctor-pe-home-"));
    return buildReport({
      root,
      home,
      cwd: home,
      fetchLatest: async () => "0.4.0",
      probe: async () => [],
      bunVersion: async () => "1.3.10",
      phantomVersion: async () => null,
      env,
    });
  }
  function line(r: Awaited<ReturnType<typeof report>>) {
    const install = r.sections.find((s) => s.title === "install")!;
    return install.lines.find((l) => l.label === "phantom exec")!;
  }

  test("ok inside a session, value-free", async () => {
    const r = await report(session());
    const l = line(r);
    expect(l.status).toBe("ok");
    expect(l.detail).toContain("phantom exec session on 127.0.0.1:54321");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(PROXY_TOKEN);
  });

  test("warns for a placeholder outside a session", async () => {
    const l = line(await report({ ANTHROPIC_API_KEY: TOKEN }));
    expect(l.status).toBe("warn");
    expect(l.fix).toContain("phantom exec -- <cmd>");
  });

  test("ok and quiet with no phantom variables", async () => {
    const l = line(await report({}));
    expect(l.status).toBe("ok");
    expect(l.detail).toBe("not a phantom exec session");
  });
});
