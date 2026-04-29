#!/usr/bin/env bun
/**
 * ashlr upgrade-flow.ts — terminal-native free-to-pro upgrade.
 *
 * Driven by the /ashlr-upgrade skill. Walks the user from free → pro/team
 * entirely in the terminal, in under 90 seconds.
 *
 * Usage:
 *   bun run scripts/upgrade-flow.ts
 *   bun run scripts/upgrade-flow.ts --tier pro --annual
 *   bun run scripts/upgrade-flow.ts --tier team --annual --email you@example.com
 *   bun run scripts/upgrade-flow.ts --no-poll   # skip activation polling (testing)
 *
 * Env:
 *   ASHLR_API_URL      — default https://api.ashlr.ai
 *   ASHLR_PRO_TOKEN    — if set, skip sign-in and go straight to checkout
 *   ASHLR_NO_BROWSER=1 — skip browser open (headless / CI / SSH)
 *
 * Stdout: the user-facing transcript.
 * Exits: 0 on success or graceful timeout, 1 on fatal error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import * as readline from "readline";
import { randomBytes } from "crypto";
import { recordNudgeClicked, maybeSyncToCloud as maybeSyncNudgeEvents } from "../servers/_nudge-events.ts";
import { validateProToken } from "../servers/_pro.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
const SITE_URL = process.env["ASHLR_SITE_URL"] ?? "https://plugin.ashlr.ai";
const ASHLR_DIR = join(homedir(), ".ashlr");
const TOKEN_FILE = join(ASHLR_DIR, "pro-token");
const ENV_FILE = join(ASHLR_DIR, "env");
const NO_BROWSER = process.env["ASHLR_NO_BROWSER"] === "1";

// Poll intervals / timeouts
const AUTH_POLL_INTERVAL_MS = 3_000;
const AUTH_POLL_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes
const BILLING_POLL_INTERVAL_MS = 5_000;
const BILLING_POLL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

// Brand colors (truecolor)
const TTY = process.stdout.isTTY;
const GREEN  = TTY ? "\x1b[38;2;0;200;120m" : "";
const BOLD   = TTY ? "\x1b[1m" : "";
const DIM    = TTY ? "\x1b[2m" : "";
const RESET  = TTY ? "\x1b[0m" : "";
const CYAN   = TTY ? "\x1b[38;2;100;210;255m" : "";
const YELLOW = TTY ? "\x1b[38;2;255;200;80m" : "";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Flags {
  tier: "pro" | "team" | null;
  annual: boolean;
  email: string | null;
  noPoll: boolean;
}

function parseArgs(): Flags {
  const args = process.argv.slice(2);
  const flags: Flags = { tier: null, annual: false, email: null, noPoll: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--annual") flags.annual = true;
    if (a === "--no-poll") flags.noPoll = true;
    if (a === "--tier" && args[i + 1]) {
      const v = args[++i]!;
      if (v === "pro" || v === "team") flags.tier = v;
    }
    if (a === "--email" && args[i + 1]) {
      flags.email = args[++i]!;
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function print(msg: string): void {
  process.stdout.write(msg + "\n");
}

function banner(): void {
  print("");
  print(`${BOLD}${GREEN}  ╔══════════════════════════════════╗${RESET}`);
  print(`${BOLD}${GREEN}  ║      ashlr  ·  upgrade           ║${RESET}`);
  print(`${BOLD}${GREEN}  ╚══════════════════════════════════╝${RESET}`);
  print("");
}

function step(n: number, total: number, label: string): void {
  print(`\n${CYAN}${BOLD}▬▬▬ STEP ${n}/${total}: ${label} ▬▬▬${RESET}`);
}

function ok(msg: string): void {
  print(`${GREEN}${BOLD}  ✓${RESET}  ${msg}`);
}

function info(msg: string): void {
  print(`${DIM}  ${msg}${RESET}`);
}

function warn(msg: string): void {
  print(`${YELLOW}  !  ${msg}${RESET}`);
}

// Animated dots on one line, returns a stopper function.
function startDots(prefix: string): () => void {
  const frames = [".", "..", "..."];
  let i = 0;
  if (!TTY) {
    process.stdout.write(prefix + "   ");
    return () => { process.stdout.write("\n"); };
  }

  process.stdout.write(prefix);
  const timer = setInterval(() => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(prefix + " " + frames[i % 3]!);
    i++;
  }, 500);

  return () => {
    clearInterval(timer);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  };
}

// ---------------------------------------------------------------------------
// Stdin input with timeout
// ---------------------------------------------------------------------------

async function prompt(question: string, timeoutMs = 60_000): Promise<string> {
  process.stdout.write(`  ${BOLD}${question}${RESET} `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("Input timed out"));
    }, timeoutMs);

    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(line.trim());
    });

    rl.once("close", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

function ensureAshlrDir(): void {
  if (!existsSync(ASHLR_DIR)) {
    mkdirSync(ASHLR_DIR, { recursive: true, mode: 0o700 });
  }
}

function saveToken(token: string): void {
  ensureAshlrDir();
  writeFileSync(TOKEN_FILE, token, { encoding: "utf8", mode: 0o600 });
  // Try to set mode 0600 explicitly (belt-and-suspenders for older bun)
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* best-effort */ }
}

async function writeEnvFile(token: string): Promise<void> {
  ensureAshlrDir();
  let existing = "";
  try { existing = await readFile(ENV_FILE, "utf8"); } catch { /* new file */ }

  // Remove any prior ASHLR_PRO_TOKEN line, then append the fresh one
  const lines = existing
    .split("\n")
    .filter((l) => !l.startsWith("export ASHLR_PRO_TOKEN="));
  lines.push(`export ASHLR_PRO_TOKEN=${token}`);

  await writeFile(ENV_FILE, lines.join("\n").trimStart() + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(ENV_FILE, 0o600); } catch { /* best-effort */ }
}

function readStoredToken(): string | null {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiFetch(
  path: string,
  opts: { method?: string; body?: unknown; token?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let data: unknown;
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Browser open — cross-platform
// ---------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  if (NO_BROWSER) {
    warn("ASHLR_NO_BROWSER=1 — skipping browser open.");
    print(`\n  Open this URL manually:\n\n  ${BOLD}${url}${RESET}\n`);
    return;
  }

  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case "darwin":
      cmd = "open"; args = [url]; break;
    case "win32":
      cmd = "cmd"; args = ["/c", "start", '""', url]; break;
    default: // linux + others
      cmd = "xdg-open"; args = [url]; break;
  }

  const fallbackToUrl = () => {
    warn("Could not open a browser automatically.");
    print(`\n  Open this URL manually:\n\n  ${BOLD}${url}${RESET}\n`);
  };

  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // Attach the error listener BEFORE detaching — spawn() can reach the
    // "spawned successfully" callback and then emit 'error' asynchronously
    // (e.g. when the child exits with ENOENT on Windows, or xdg-open is
    // missing on a minimal Linux). Without this listener the error would
    // crash the process or be silently swallowed and the user would see
    // "Opened checkout" when nothing actually opened.
    let errored = false;
    child.once("error", () => { errored = true; fallbackToUrl(); });
    child.unref();
    // Give the child time to surface immediate spawn errors before we claim
    // success. Windows' `cmd /c start` emits ENOENT / URL-handler failures
    // noticeably later than POSIX `open` / `xdg-open`, so we wait longer
    // there to avoid a false "Opened checkout" message.
    const settleMs = process.platform === "win32" ? 500 : 50;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (!errored) {
      ok("Opened checkout in your browser. Complete payment to activate Pro.");
    }
  } catch {
    fallbackToUrl();
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Check current tier
// ---------------------------------------------------------------------------

async function checkCurrentTier(): Promise<{ token: string; tier: string } | null> {
  const envToken = process.env["ASHLR_PRO_TOKEN"];
  const storedToken = readStoredToken();
  const token = envToken ?? storedToken;
  if (!token) return null;

  try {
    const { ok: ok_, data } = await apiFetch("/billing/status", { token });
    if (ok_) {
      const d = data as { tier?: string };
      return { token, tier: d.tier ?? "free" };
    }
  } catch {
    // network error — treat as unauthenticated
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2 — Sign in (GitHub or magic-link)
// ---------------------------------------------------------------------------

/**
 * Pure, injectable polling function for GitHub OAuth session completion.
 * Exported for unit testing — does not touch UI, browser, or file system.
 */
export async function pollAuthStatusBySid(
  sid: string,
  opts: {
    apiUrl: string;
    timeoutMs: number;
    intervalMs: number;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ apiToken: string }> {
  const fetcher = opts.fetch ?? globalThis.fetch;
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    await sleep(opts.intervalMs);

    const res = await fetcher(
      `${opts.apiUrl}/auth/status?session=${encodeURIComponent(sid)}`,
      { headers: { "Content-Type": "application/json" } },
    );

    if (!res.ok) {
      // 4xx → immediate throw, not retried
      let body: unknown;
      try { body = await res.json(); } catch { body = {}; }
      const msg = (body as { error?: string }).error ?? `auth/status returned HTTP ${res.status}`;
      throw new Error(msg);
    }

    let data: unknown;
    try { data = await res.json(); } catch { data = {}; }
    const d = data as { ready?: boolean; apiToken?: string };
    if (d.ready && d.apiToken) {
      return { apiToken: d.apiToken };
    }
  }

  throw new Error(
    "GitHub sign-in timed out. Complete the browser flow and run /ashlr-upgrade again.",
  );
}

async function signInWithGitHub(): Promise<string> {
  const sid = randomBytes(16).toString("hex");
  const url = `${SITE_URL}/auth/github?sid=${sid}`;

  await openBrowser(url);
  ok("Opened GitHub sign-in in your browser. Approve access to complete.");
  info("Waiting for GitHub authorisation (up to 3 minutes)...");
  print("");

  const stopDots = startDots("  Waiting");
  try {
    const { apiToken } = await pollAuthStatusBySid(sid, {
      apiUrl: API_URL,
      timeoutMs: AUTH_POLL_TIMEOUT_MS,
      intervalMs: AUTH_POLL_INTERVAL_MS,
    });
    stopDots();

    // Best-effort: display github login. If /auth/whoami doesn't exist yet, skip.
    try {
      const whoami = await apiFetch("/auth/whoami", { token: apiToken });
      if (whoami.ok) {
        const d = whoami.data as { login?: string };
        if (d.login) ok(`Signed in as @${d.login}`);
        else ok("Signed in ✓");
      } else {
        ok("Signed in ✓");
      }
    } catch {
      ok("Signed in ✓");
    }

    return apiToken;
  } catch (err) {
    stopDots();
    throw err;
  }
}

async function signInWithMagicLink(emailArg: string | null): Promise<string> {
  let email = emailArg;
  if (!email) {
    try {
      email = await prompt("[ASHLR_PROMPT: Email to sign in?]");
    } catch {
      throw new Error("No email provided.");
    }
  } else {
    print(`  Using email: ${BOLD}${email}${RESET}`);
  }

  if (!email || !email.includes("@")) {
    throw new Error("Invalid email address.");
  }

  // POST /auth/send
  const sendRes = await apiFetch("/auth/send", { method: "POST", body: { email } });
  if (!sendRes.ok) {
    const d = sendRes.data as { error?: string };
    throw new Error(d.error ?? `Failed to send magic link (HTTP ${sendRes.status})`);
  }

  ok(`Magic link sent to ${BOLD}${email}${RESET}. Check your inbox — click the link to continue.`);
  info("Waiting for you to click the link (up to 3 minutes)...");
  print("");

  // Poll /auth/status
  const stopDots = startDots("  Waiting");
  const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      await sleep(AUTH_POLL_INTERVAL_MS);
      try {
        const res = await apiFetch(`/auth/status?email=${encodeURIComponent(email)}`, {});
        if (res.ok) {
          const d = res.data as { ready?: boolean; apiToken?: string };
          if (d.ready && d.apiToken) {
            stopDots();
            ok("Sign-in confirmed.");
            return d.apiToken;
          }
        }
      } catch {
        // network hiccup — keep polling
      }
    }
  } finally {
    stopDots();
  }

  throw new Error(
    "Sign-in timed out. Check your email and try again, or run /ashlr-upgrade once you've clicked the link.",
  );
}

/** Present auth-method menu and route to the right flow. */
async function pickAuthMethod(emailFlag: string | null): Promise<string> {
  print("");
  print(`${DIM}  No active Pro token found. Let's sign you in first.${RESET}`);

  // --email flag → skip menu, go straight to magic-link (back-compat)
  if (emailFlag !== null) {
    return signInWithMagicLink(emailFlag);
  }

  print("");
  print(`  Sign in with:`);
  print(`    ${BOLD}1)${RESET} GitHub ${DIM}(recommended)${RESET} — one click in your browser`);
  print(`    ${BOLD}2)${RESET} Email magic-link`);
  print(`  ${DIM}Choice [1]:${RESET}`);
  print("");

  let choice: string;
  try {
    choice = await prompt("[ASHLR_PROMPT: Choice [1]:]");
  } catch {
    choice = "1";
  }

  if (choice === "2") {
    return signInWithMagicLink(null);
  }

  // Default: GitHub (Enter or "1")
  return signInWithGitHub();
}

// ---------------------------------------------------------------------------
// Step 3 — Pick a tier
// ---------------------------------------------------------------------------

type TierKey = "pro" | "pro-annual" | "team" | "team-annual";

interface TierOption {
  key: TierKey;
  label: string;
}

const TIER_OPTIONS: TierOption[] = [
  { key: "pro",         label: "Pro  ·  $12/mo" },
  { key: "pro-annual",  label: "Pro  ·  $120/yr  (save 17%)" },
  { key: "team",        label: "Team ·  $24/user/mo" },
  { key: "team-annual", label: "Team ·  $240/user/yr  (save 17%)" },
];

async function pickTier(flags: Flags): Promise<TierKey> {
  // If fully specified by flags, skip interactive prompt
  if (flags.tier) {
    const key: TierKey = flags.annual
      ? `${flags.tier}-annual`
      : flags.tier;
    const opt = TIER_OPTIONS.find((o) => o.key === key);
    if (opt) {
      info(`Using tier: ${opt.label}`);
      return key;
    }
  }

  print("");
  TIER_OPTIONS.forEach((o, i) => {
    const isDefault = i === 0;
    print(`  ${BOLD}${i + 1}${RESET})  ${o.label}${isDefault ? DIM + "  [default]" + RESET : ""}`);
  });
  print("");

  let choice: string;
  try {
    choice = await prompt("[ASHLR_PROMPT: Choose a plan (1-4, default 1):]");
  } catch {
    choice = "1";
  }

  const idx = parseInt(choice || "1", 10) - 1;
  if (idx < 0 || idx >= TIER_OPTIONS.length) {
    info("Invalid selection — defaulting to Pro monthly.");
    return "pro";
  }
  return TIER_OPTIONS[idx]!.key;
}

// ---------------------------------------------------------------------------
// Step 4 — Open checkout
// ---------------------------------------------------------------------------

async function openCheckout(tier: TierKey, token: string): Promise<void> {
  const isTeam = tier.startsWith("team");

  let seats = 1;
  if (isTeam) {
    let seatsStr: string;
    try {
      seatsStr = await prompt("[ASHLR_PROMPT: How many seats (default 3):]");
    } catch {
      seatsStr = "3";
    }
    seats = Math.max(1, parseInt(seatsStr || "3", 10) || 3);
  }

  const res = await apiFetch("/billing/checkout", {
    method: "POST",
    body: { tier, seats },
    token,
  });

  if (!res.ok) {
    const d = res.data as { error?: string };
    throw new Error(d.error ?? `Checkout failed (HTTP ${res.status})`);
  }

  const d = res.data as { url?: string; trial?: { days?: number } | null };
  if (!d.url) throw new Error("No checkout URL returned from server.");

  if (d.trial?.days && d.trial.days > 0) {
    info(
      `First-time upgrade: ${d.trial.days}-day free trial included. ` +
        `No card charged until day ${d.trial.days}; cancel anytime before then.`,
    );
  }

  await openBrowser(d.url);
}

// ---------------------------------------------------------------------------
// Step 5 — Poll for activation
// ---------------------------------------------------------------------------

async function pollActivation(token: string): Promise<boolean> {
  info("Polling for payment confirmation (up to 10 minutes)...");
  const stopDots = startDots("  Waiting");
  const deadline = Date.now() + BILLING_POLL_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      await sleep(BILLING_POLL_INTERVAL_MS);
      try {
        const res = await apiFetch("/billing/status", { token });
        if (res.ok) {
          const d = res.data as { tier?: string };
          if (d.tier === "pro" || d.tier === "team") {
            stopDots();
            return true;
          }
        }
      } catch {
        // keep polling
      }
    }
  } finally {
    stopDots();
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printActivationSuccess(
  tier: string,
  opts: { trialEndsAt?: string | null } = {},
): void {
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const trialSuffix = opts.trialEndsAt
    ? ` (trial ends ${new Date(opts.trialEndsAt).toLocaleDateString()})`
    : "";
  print("");
  print(`${GREEN}${BOLD}  ✓ Pro activated! Plan: ${tierLabel}${trialSuffix}${RESET}`);
  print(`  Your API token is saved locally. All Pro features are unlocked.`);
  print("");
  print(`  What just changed:`);
  print(`  - Hosted LLM summarizer — Ollama not required`);
  print(`  - Cross-machine stats sync`);
  print(`  - Leaderboard participation`);
  print(`  - Priority support at support@ashlr.ai`);
  print("");
  print(`${DIM}  Next: run /ashlr-dashboard to see your usage.${RESET}`);
  print("");
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const flags = parseArgs();
  const totalSteps = 5;

  // Record the click as early as possible — before any network I/O — so even
  // an aborted run still counts toward conversion. Correlates to the most
  // recent nudge_shown in the same session (within 30 min). Fire-and-forget.
  void recordNudgeClicked({}).catch(() => {});
  maybeSyncNudgeEvents();

  banner();

  // ── Step 1: Check current tier ──────────────────────────────────────────
  step(1, totalSteps, "Checking current tier");

  let token: string | null = null;
  let currentTier = "free";

  const existing = await checkCurrentTier();
  if (existing) {
    token = existing.token;
    currentTier = existing.tier;
  }

  if (currentTier === "pro" || currentTier === "team") {
    ok(`You're already on ${currentTier.charAt(0).toUpperCase() + currentTier.slice(1)}.`);
    info("Run /ashlr-dashboard to see usage.");
    return 0;
  }

  ok(currentTier === "free" && token ? "Authenticated as free user." : "Not signed in yet.");

  // ── Step 2: Sign in if needed ────────────────────────────────────────────
  if (!token) {
    step(2, totalSteps, "Sign in");

    try {
      token = await pickAuthMethod(flags.email);
    } catch (err) {
      warn(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Persist token
    saveToken(token);
    await writeEnvFile(token);
    process.env["ASHLR_PRO_TOKEN"] = token;
    ok("Token saved to ~/.ashlr/pro-token and ~/.ashlr/env (auto-loaded on next session).");
  } else {
    step(2, totalSteps, "Sign in");
    ok("Already authenticated — skipping sign-in.");
  }

  // ── Step 3: Pick a tier ──────────────────────────────────────────────────
  step(3, totalSteps, "Choose your plan");

  let chosenTier: TierKey;
  try {
    chosenTier = await pickTier(flags);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return 1;
  }

  ok(`Selected: ${TIER_OPTIONS.find((o) => o.key === chosenTier)?.label ?? chosenTier}`);

  // ── Step 4: Open checkout ────────────────────────────────────────────────
  step(4, totalSteps, "Open Stripe checkout");

  try {
    await openCheckout(chosenTier, token);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // ── Step 5: Poll for activation ──────────────────────────────────────────
  if (flags.noPoll) {
    step(5, totalSteps, "Activate Pro");
    info("--no-poll set — skipping activation check.");
    return 0;
  }

  step(5, totalSteps, "Waiting for payment confirmation");

  const activated = await pollActivation(token);

  if (activated) {
    // Validate the token to get the real tier + trial info, and seed the cache
    // so the user doesn't have to wait for a network round-trip on next launch.
    let finalTier = "pro";
    let trialEndsAt: string | null = null;
    try {
      const validation = await validateProToken();
      if (validation.valid && validation.plan) {
        finalTier = validation.plan;
        trialEndsAt = validation.trialEndsAt ?? null;
      }
    } catch { /* fall back to billing/status */ }

    if (!trialEndsAt) {
      try {
        const r = await apiFetch("/billing/status", { token });
        if (r.ok) {
          const d = r.data as { tier?: string; trialEndsAt?: string | null };
          finalTier = d.tier ?? finalTier;
          trialEndsAt = d.trialEndsAt ?? null;
        }
      } catch { /* use defaults */ }
    }

    printActivationSuccess(finalTier, { trialEndsAt });
  } else {
    print("");
    warn("Haven't detected payment yet.");
    info("Once you complete checkout, run /ashlr-upgrade again to verify and activate.");
    print("");
  }

  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`upgrade-flow: fatal — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
