#!/usr/bin/env bun
/**
 * ashlr doctor — single-shot diagnostics for an ashlr-plugin install.
 *
 * Designed to run in under 10 seconds and produce an output block that's
 * safe to paste into a GitHub issue. Every ⚠ / ✗ line carries a one-line
 * copy-pastable fix.
 *
 * Exported helpers are consumed by __tests__/doctor.test.ts — keep their
 * signatures stable.
 */

import { spawn } from "bun";
import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { c, sym, box, isColorEnabled } from "./ui.ts";

export type Status = "ok" | "warn" | "fail";
export interface Line {
  status: Status;
  label: string;
  detail: string;
  fix?: string;
}
export interface Section {
  title: string;
  lines: Line[];
}
export interface Report {
  header: string;
  sections: Section[];
  warnings: number;
  failures: number;
}

const GLYPH: Record<Status, string> = { ok: sym.check, warn: sym.warn, fail: sym.cross };

/** Colored glyph for TTY rendering; falls back to the plain glyph otherwise. */
function coloredGlyph(status: Status): string {
  const g = GLYPH[status];
  if (!isColorEnabled()) return g;
  if (status === "ok") return c.green(g);
  if (status === "warn") return c.yellow(g);
  return c.red(g);
}

// ---------- plugin root resolution ----------

export function resolvePluginRoot(startDir: string, env = process.env): string | null {
  if (env.CLAUDE_PLUGIN_ROOT && existsSync(join(env.CLAUDE_PLUGIN_ROOT, ".claude-plugin/plugin.json"))) {
    return env.CLAUDE_PLUGIN_ROOT;
  }
  let dir = resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".claude-plugin/plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------- plugin.json ----------

async function readPluginJson(root: string): Promise<{ name?: string; version?: string } | null> {
  try {
    return JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---------- latest release ----------

export async function fetchLatestRelease(
  url = "https://api.github.com/repos/ashlrai/ashlr-plugin/releases/latest",
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { "user-agent": "ashlr-doctor" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { tag_name?: string; name?: string };
    return (j.tag_name || j.name || "").replace(/^v/, "") || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------- MCP probe ----------

export interface ProbeResult {
  server: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

export async function probeServer(
  name: string,
  scriptPath: string,
  perServerTimeoutMs = 2000,
): Promise<ProbeResult> {
  if (!existsSync(scriptPath)) {
    return { server: name, ok: false, tools: [], error: "server script missing" };
  }
  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ashlr-doctor", version: "1" } },
  };
  const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const payload = JSON.stringify(initReq) + "\n" + JSON.stringify(listReq) + "\n";

  const proc = spawn({
    cmd: ["bun", "run", scriptPath],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, perServerTimeoutMs);

  try {
    proc.stdin.write(payload);
    await proc.stdin.end();
  } catch {
    // proc may already be dead
  }

  let out = "";
  try {
    out = await new Response(proc.stdout).text();
  } catch {
    // stream errored
  }
  // best-effort: we've already captured stdout and only need the process to settle; exit-code and signal reasons are not used in the probe.
  await proc.exited.catch(() => {});
  clearTimeout(timer);

  const tools: string[] = [];
  let sawListResult = false;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
        sawListResult = true;
        for (const t of msg.result.tools) if (t && t.name) tools.push(String(t.name));
      }
    } catch {
      // non-JSON log line
    }
  }

  if (!sawListResult) return { server: name, ok: false, tools: [], error: "no tools/list response" };
  return { server: name, ok: true, tools };
}

export async function probeAll(
  servers: Array<{ name: string; script: string }>,
  totalCapMs = 5000,
  perServerTimeoutMs = 2000,
): Promise<ProbeResult[]> {
  const work = Promise.all(servers.map((s) => probeServer(s.name, s.script, perServerTimeoutMs)));
  const cap = new Promise<ProbeResult[]>((resolveP) =>
    setTimeout(
      () =>
        resolveP(
          servers.map((s) => ({ server: s.name, ok: false, tools: [], error: "total probe cap exceeded" })),
        ),
      totalCapMs,
    ),
  );
  return await Promise.race([work, cap]);
}

// ---------- helpers ----------

async function readJson<T = any>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

function versionCompare(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    // owner-execute bit
    return (st.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

// ---------- build report ----------

export interface BuildOpts {
  root: string;
  home?: string;
  cwd?: string;
  claudeSettingsPath?: string;
  statsPath?: string;
  fetchLatest?: () => Promise<string | null>;
  probe?: (servers: Array<{ name: string; script: string }>) => Promise<ProbeResult[]>;
  bunVersion?: () => Promise<string | null>;
}

/** Returns true if the allow array contains at least one ashlr MCP wildcard. */
export function hasAshlrAllowEntry(allow: unknown): boolean {
  if (!Array.isArray(allow)) return false;
  return (allow as string[]).some((e) => /^mcp__ashlr(-|__)/.test(e) || e === "mcp__ashlr-*");
}

async function getBunVersion(): Promise<string | null> {
  try {
    const proc = spawn({ cmd: ["bun", "--version"], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function buildReport(opts: BuildOpts): Promise<Report> {
  const root = opts.root;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const settingsPath = opts.claudeSettingsPath ?? join(home, ".claude/settings.json");
  const statsPath = opts.statsPath ?? join(home, ".ashlr/stats.json");
  const fetchLatest = opts.fetchLatest ?? (() => fetchLatestRelease());
  const probe = opts.probe ?? ((servers) => probeAll(servers));
  const bunVersionFn = opts.bunVersion ?? getBunVersion;

  const plugin = await readPluginJson(root);
  const currentVersion = plugin?.version ?? "unknown";
  const [latestVersion, bunVersion] = await Promise.all([fetchLatest(), bunVersionFn()]);

  let versionTag: string;
  if (!latestVersion) versionTag = "latest: unknown";
  else {
    const cmp = versionCompare(currentVersion, latestVersion);
    if (cmp === 0) versionTag = `latest: v${latestVersion} · up to date`;
    else if (cmp < 0) versionTag = `latest: v${latestVersion} · update available`;
    else versionTag = `latest: v${latestVersion} · ahead of release`;
  }
  const header = `ashlr doctor · plugin v${currentVersion} (${versionTag})`;

  const sections: Section[] = [];

  // ----- install -----
  const install: Line[] = [];
  install.push({ status: "ok", label: "plugin root", detail: root });

  if (bunVersion) {
    install.push({ status: "ok", label: "bun", detail: bunVersion });
  } else {
    install.push({
      status: "fail",
      label: "bun",
      detail: "not found on PATH",
      fix: "install: curl -fsSL https://bun.sh/install | bash",
    });
  }

  const mcpSdkPkg = await readJson<{ version?: string }>(
    join(root, "node_modules/@modelcontextprotocol/sdk/package.json"),
  );
  const corePkg = await readJson<{ version?: string }>(
    join(root, "node_modules/@ashlr/core-efficiency/package.json"),
  );
  if (!mcpSdkPkg || !corePkg) {
    const missing: string[] = [];
    if (!mcpSdkPkg) missing.push("@modelcontextprotocol/sdk");
    if (!corePkg) missing.push("@ashlr/core-efficiency");
    install.push({
      status: "fail",
      label: "node_modules",
      detail: `missing: ${missing.join(", ")}`,
      fix: `cd ${root} && bun install`,
    });
  } else {
    install.push({
      status: "ok",
      label: "node_modules",
      detail: `@modelcontextprotocol/sdk@${mcpSdkPkg.version ?? "?"} · @ashlr/core-efficiency@${corePkg.version ?? "?"}`,
    });
  }
  sections.push({ title: "install", lines: install });

  // ----- mcp servers -----
  const servers = [
    { name: "efficiency", script: join(root, "servers/efficiency-server.ts") },
    { name: "sql",        script: join(root, "servers/sql-server.ts") },
    { name: "bash",       script: join(root, "servers/bash-server.ts") },
    { name: "tree",       script: join(root, "servers/tree-server.ts") },
    { name: "http",       script: join(root, "servers/http-server.ts") },
    { name: "diff",       script: join(root, "servers/diff-server.ts") },
    { name: "logs",       script: join(root, "servers/logs-server.ts") },
    { name: "genome",     script: join(root, "servers/genome-server.ts") },
  ];
  const mcpLines: Line[] = [];
  const results = await probe(servers);
  for (const r of results) {
    if (r.ok) {
      const count = r.tools.length;
      mcpLines.push({
        status: "ok",
        label: r.server,
        detail: `${count} tool${count === 1 ? "" : "s"}: ${r.tools.join(", ") || "(none)"}`,
      });
    } else {
      mcpLines.push({
        status: "fail",
        label: r.server,
        detail: `unreachable (${r.error ?? "unknown error"})`,
        fix: `bun run ${join(root, `servers/${r.server === "efficiency" ? "efficiency-server" : r.server + "-server"}.ts`)} < /dev/null  # check startup errors`,
      });
    }
  }
  sections.push({ title: "mcp servers", lines: mcpLines });

  // ----- runtime state -----
  const runtime: Line[] = [];

  // stats
  let statsLine: Line;
  if (!existsSync(statsPath)) {
    statsLine = {
      status: "warn",
      label: "stats.json",
      detail: "not found (will be created on first tool call)",
      fix: `mkdir -p ${dirname(statsPath)}  # harmless; created automatically`,
    };
  } else {
    const stats = await readJson<any>(statsPath);
    if (!stats) {
      statsLine = {
        status: "warn",
        label: "stats.json",
        detail: "unreadable — file exists but won't parse",
        fix: `mv ${statsPath} ${statsPath}.corrupt  # preserves the file; a fresh one is created on next call`,
      };
    } else {
      const life = stats.lifetime ?? {};
      const sess = stats.session ?? {};
      const calls = life.calls ?? sess.calls ?? 0;
      const saved = life.tokensSaved ?? sess.tokensSaved ?? 0;
      statsLine = {
        status: "ok",
        label: "stats.json",
        detail: `${calls.toLocaleString()} lifetime calls · ${saved.toLocaleString()} tokens saved`,
      };
    }
  }
  runtime.push(statsLine);

  // genome
  const genomeDir = join(cwd, ".ashlrcode/genome");
  if (existsSync(genomeDir)) {
    runtime.push({ status: "ok", label: "genome", detail: `found at ${genomeDir}` });
  } else {
    runtime.push({
      status: "warn",
      label: "genome",
      detail: "no .ashlrcode/genome in cwd",
      fix: "run: /ashlr-genome-init",
    });
  }

  // settings
  const settings = existsSync(settingsPath) ? await readJson<any>(settingsPath) : null;
  const ashlr = settings?.ashlr ?? {};
  const attribution = ashlr.attribution ?? true;
  const toolRedirect = ashlr.toolRedirect ?? true;
  const editBatchingNudge = ashlr.editBatchingNudge ?? true;
  const toggles = `attribution:${attribution ? "on" : "off"} toolRedirect:${toolRedirect ? "on" : "off"} editBatchingNudge:${editBatchingNudge ? "on" : "off"}`;
  if (!settings) {
    runtime.push({
      status: "warn",
      label: "settings",
      detail: `no ~/.claude/settings.json — using defaults (${toggles})`,
      fix: "run: /ashlr-settings  # creates and edits the file",
    });
  } else if (toolRedirect === false) {
    runtime.push({
      status: "warn",
      label: "settings",
      detail: `${toggles} — toolRedirect:off disables the core Read/Grep/Edit savings`,
      fix: "run: /ashlr-settings set toolRedirect on",
    });
  } else {
    runtime.push({ status: "ok", label: "settings", detail: toggles });
  }

  // allowlist check
  const allowList = settings?.permissions?.allow;
  if (hasAshlrAllowEntry(allowList)) {
    runtime.push({
      status: "ok",
      label: "allowlist",
      detail: "ashlr MCP tools pre-approved in ~/.claude/settings.json",
    });
  } else {
    runtime.push({
      status: "fail",
      label: "allowlist",
      detail: "ashlr MCP tools not in allowlist — Claude Code will prompt on every ashlr__ call",
      fix: "run: /ashlr-allow",
    });
  }

  // status line
  const statusLineCmd: string | undefined = settings?.statusLine?.command;
  if (statusLineCmd && statusLineCmd.includes("savings-status-line.ts")) {
    runtime.push({ status: "ok", label: "status line", detail: "savings-status-line.ts wired" });
  } else {
    runtime.push({
      status: "warn",
      label: "status line",
      detail: "not installed",
      fix: `bun run ${join(root, "scripts/install-status-line.ts")}`,
    });
  }

  sections.push({ title: "runtime state", lines: runtime });

  // ----- hooks -----
  const hookFiles = [
    "session-start.ts",
    "tool-redirect.ts",
    "commit-attribution.ts",
    "edit-batching-nudge.ts",
  ];
  const hookLines: Line[] = [];
  const notExec: string[] = [];
  for (const h of hookFiles) {
    const p = join(root, "hooks", h);
    if (!existsSync(p)) {
      hookLines.push({
        status: "fail",
        label: h,
        detail: "missing",
        fix: `cd ${root} && git checkout hooks/${h}`,
      });
      continue;
    }
    if (!isExecutable(p)) {
      notExec.push(p);
      hookLines.push({
        status: "warn",
        label: h,
        detail: "not executable",
        fix: `chmod +x ${p}`,
      });
    } else {
      hookLines.push({ status: "ok", label: h, detail: "" });
    }
  }
  if (notExec.length > 1) {
    // Collapse into a single combined fix for convenience (still keep per-line fixes too)
    hookLines.push({
      status: "warn",
      label: "fix all",
      detail: `${notExec.length} hooks not executable`,
      fix: `chmod +x ${notExec.join(" ")}`,
    });
  }
  sections.push({ title: "hooks", lines: hookLines });

  let warnings = 0;
  let failures = 0;
  for (const s of sections) {
    for (const l of s.lines) {
      if (l.status === "warn") warnings++;
      else if (l.status === "fail") failures++;
    }
  }

  return { header, sections, warnings, failures };
}

// ---------- formatting ----------

export function formatReport(report: Report): string {
  const out: string[] = [];
  // Header — keep header text intact (tests match "ashlr doctor") but colorize
  // the bits after.
  out.push(isColorEnabled() ? c.bold(c.brightMagenta(report.header)) : report.header);
  out.push("");
  // column width: 17 chars for label inside each section for alignment
  const LABEL_W = 15;
  for (const section of report.sections) {
    out.push(isColorEnabled() ? c.bold(c.cyan(section.title)) : section.title);
    for (const line of section.lines) {
      // pad the raw label first so columns stay aligned regardless of color
      // escape codes.
      const paddedLabel = line.label.padEnd(LABEL_W, " ");
      const label = isColorEnabled() ? c.dim(paddedLabel) : paddedLabel;
      const detail = line.detail ? `  ${line.detail}` : "";
      out.push(`  ${coloredGlyph(line.status)} ${label}${detail}`);
      if (line.fix && line.status !== "ok") {
        const fixLabel = isColorEnabled() ? c.yellow("fix:") : "fix:";
        const fixText = isColorEnabled() ? c.dim(line.fix) : line.fix;
        out.push(`      ${fixLabel} ${fixText}`);
      }
    }
    out.push("");
  }

  // Summary — colored counts, boxed when we have a TTY.
  const wText = `${report.warnings} warning${report.warnings === 1 ? "" : "s"}`;
  const fText = `${report.failures} failure${report.failures === 1 ? "" : "s"}`;
  if (isColorEnabled()) {
    const w = report.warnings === 0 ? c.dim(wText) : c.yellow(wText);
    const f = report.failures === 0 ? c.dim(fText) : c.red(fText);
    const summary = `${w} ${c.dim(sym.dot)} ${f}`;
    // Overall status word ahead of the counts.
    let tone: string;
    let color: (s: string) => string;
    if (report.failures > 0) { tone = "unhealthy"; color = c.red; }
    else if (report.warnings > 0) { tone = "degraded"; color = c.yellow; }
    else { tone = "healthy"; color = c.green; }
    const titleWord = c.bold(color(tone));
    const body = `${titleWord}  ${summary}`;
    out.push(box(body, { title: "summary", color }));
  } else {
    out.push(`${wText} · ${fText}`);
  }
  return out.join("\n");
}

// ---------- main ----------

async function main(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolvePluginRoot(here);
  if (!root) {
    process.stderr.write(
      "ashlr doctor: could not locate plugin root.\n" +
        "  set CLAUDE_PLUGIN_ROOT to the plugin install directory, or run this script from inside it.\n",
    );
    return 2;
  }
  const report = await buildReport({ root });
  process.stdout.write(formatReport(report) + "\n");
  return report.failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
