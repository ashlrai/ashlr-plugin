import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  envFileToken,
  keychainLoad,
  migrateEnvFileToken,
  storeProToken,
  type Runner,
} from "../servers/_pro-token-keychain.ts";

const TOKEN = "fixture-pro-token-0123456789";

/** An in-memory keychain behind the `security` / `secret-tool` argv shapes. */
function fakeKeychain(opts: { fail?: boolean; corrupt?: boolean } = {}) {
  let stored: string | null = null;
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: Runner = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (opts.fail) return { status: 1, stdout: "" };
    const write = (cmd === "security" && args[0] === "-i") || args[0] === "store";
    if (write) {
      stored = cmd === "security" ? (input ?? "").trim().split(/\s+/).pop()! : input ?? "";
      if (opts.corrupt) stored = "something-else";
      return { status: 0, stdout: "" };
    }
    return stored === null ? { status: 44, stdout: "" } : { status: 0, stdout: `${stored}\n` };
  };
  return { run, calls, get stored() { return stored; } };
}

describe("ASHLR_PRO_TOKEN keychain storage", () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ashlr-keychain-"));
    envFile = join(dir, ".ashlr", "env");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: stores in the keychain and keeps the token out of the env file`, () => {
      const kc = fakeKeychain();
      expect(storeProToken(TOKEN, envFile, { platform, env: {}, run: kc.run })).toBe("keychain");
      expect(kc.stored).toBe(TOKEN);
      expect(keychainLoad({ platform, env: {}, run: kc.run })).toBe(TOKEN);
      expect(envFileToken(envFile)).toBeNull();
    });
  }

  test("macOS passes the token on stdin to `security -i`, not argv", () => {
    const kc = fakeKeychain();
    storeProToken(TOKEN, envFile, { platform: "darwin", env: {}, run: kc.run });
    const add = kc.calls.find((c) => c.args[0] === "-i")!;
    expect(add.input).toContain(TOKEN);
    expect(kc.calls.every((c) => !c.args.join(" ").includes(TOKEN))).toBe(true);
  });

  test("macOS keeps a token with shell-special characters in the file", () => {
    const kc = fakeKeychain();
    expect(storeProToken("tok en'x", envFile, { platform: "darwin", env: {}, run: kc.run })).toBe("file");
    expect(kc.calls).toHaveLength(0);
    expect(envFileToken(envFile)).toBe("tok en'x");
  });

  test("linux passes the token on stdin, not argv", () => {
    const kc = fakeKeychain();
    storeProToken(TOKEN, envFile, { platform: "linux", env: {}, run: kc.run });
    const store = kc.calls.find((c) => c.args[0] === "store")!;
    expect(store.input).toBe(TOKEN);
    expect(store.args.join(" ")).not.toContain(TOKEN);
  });

  test("falls back to a 0600 plaintext line when the keychain fails", () => {
    const kc = fakeKeychain({ fail: true });
    expect(storeProToken(TOKEN, envFile, { platform: "darwin", env: {}, run: kc.run })).toBe("file");
    expect(envFileToken(envFile)).toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("falls back on Windows and when ASHLR_KEYCHAIN=0, without calling a backend", () => {
    const kc = fakeKeychain();
    expect(storeProToken(TOKEN, envFile, { platform: "win32", env: {}, run: kc.run })).toBe("file");
    expect(storeProToken(TOKEN, envFile, { platform: "darwin", env: { ASHLR_KEYCHAIN: "0" }, run: kc.run })).toBe("file");
    expect(kc.calls).toHaveLength(0);
    expect(readFileSync(envFile, "utf8").match(/ASHLR_PRO_TOKEN=/g)).toHaveLength(1);
  });

  test("does not trust a keychain write that reads back a different value", () => {
    const kc = fakeKeychain({ corrupt: true });
    expect(storeProToken(TOKEN, envFile, { platform: "darwin", env: {}, run: kc.run })).toBe("file");
    expect(envFileToken(envFile)).toBe(TOKEN);
  });

});

describe("migrateEnvFileToken", () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ashlr-keychain-mig-"));
    envFile = join(dir, "env");
    writeFileSync(envFile, `export OTHER=1\nexport ASHLR_PRO_TOKEN="${TOKEN}"\n`, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("moves the token and keeps other lines", () => {
    const kc = fakeKeychain();
    expect(migrateEnvFileToken(envFile, { platform: "darwin", env: {}, run: kc.run })).toBe("migrated");
    expect(kc.stored).toBe(TOKEN);
    expect(readFileSync(envFile, "utf8")).toBe("export OTHER=1\n");
  });

  test("keeps the line when the keychain is unavailable", () => {
    const kc = fakeKeychain({ fail: true });
    expect(migrateEnvFileToken(envFile, { platform: "linux", env: {}, run: kc.run })).toBe("kept");
    expect(envFileToken(envFile)).toBe(TOKEN);
  });

  test("is a no-op with no token line", () => {
    writeFileSync(envFile, "export OTHER=1\n");
    const kc = fakeKeychain();
    expect(migrateEnvFileToken(envFile, { platform: "darwin", env: {}, run: kc.run })).toBe("none");
    expect(kc.calls).toHaveLength(0);
  });
});
