import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import inventory from "../../.claude-plugin/install-manifest.json";
import { fileDigest } from "./install-manifest.ts";

export type CheckStatus = "ok" | "warn" | "fail";
/** One finding. `fix` is a single plain-words next step ("" when status is ok). */
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  root: string;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** How long to wait for each MCP server to answer, in milliseconds. */
  mcpTimeoutMs?: number;
}

const REINSTALL = "Reinstall Ashlr: npm install -g ashlr-plugin";

const check = (name: string, status: CheckStatus, detail: string, fix = ""): DoctorCheck => ({ name, status, detail, fix });

function readJson(path: string): { value?: any; error?: "missing" | "invalid" } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  }
}

/** Install: the version is readable and every shipped skill, command and hook is present and current. */
function installChecks(root: string, plugin: ReturnType<typeof readJson>): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const version = plugin.value?.version;
  out.push(typeof version === "string" && version
    ? check("version", "ok", version)
    : check("version", "fail", "No version found in .claude-plugin/plugin.json.", REINSTALL));

  // Compare against the shipped inventory, never one inferred from damaged files.
  const problems: string[] = [];
  const total = Object.keys(inventory.files).length;
  for (const [path, expected] of Object.entries(inventory.files)) {
    let status: string | undefined;
    try {
      // Do not follow an installed symlink outside the selected plugin tree.
      if (!realpathSync(join(root, path)).startsWith(realpathSync(root) + sep)) status = "unreadable";
      else if (fileDigest(join(root, path)) !== expected) status = "stale";
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
    if (status) problems.push(`${status}: ${path}`);
  }
  out.push(problems.length === 0
    ? check("files", "ok", `${total} files present`)
    : check("files", "fail", `${problems.length} of ${total} files need repair. ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; ..." : ""}`, REINSTALL));
  return out;
}

type Servers = Record<string, { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown; url?: unknown }>;

/** Configuration: plugin.json has its required fields and declares MCP servers with usable values. */
function configChecks(root: string, plugin: ReturnType<typeof readJson>): { checks: DoctorCheck[]; servers: Servers } {
  const out: DoctorCheck[] = [];
  if (plugin.error) {
    out.push(check("plugin.json", "fail",
      plugin.error === "missing" ? ".claude-plugin/plugin.json is missing." : ".claude-plugin/plugin.json is not valid JSON.", REINSTALL));
    return { checks: out, servers: {} };
  }
  out.push(typeof plugin.value?.name === "string" && plugin.value.name
    ? check("plugin.json", "ok", `name ${plugin.value.name}`)
    : check("plugin.json", "fail", 'Required setting "name" is missing.', REINSTALL));

  // Claude reads servers from plugin.json; Codex and other hosts read .mcp.json.
  let servers: unknown = plugin.value?.mcpServers;
  let source = "plugin.json";
  if (!servers) {
    const mcp = readJson(join(root, ".mcp.json"));
    servers = mcp.value?.mcpServers;
    source = ".mcp.json";
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length === 0) {
    out.push(check("mcp servers", "fail", "No MCP servers are configured.", `Reinstall Ashlr to restore the server entry: npm install -g ashlr-plugin`));
    return { checks: out, servers: {} };
  }
  const valid: Servers = {};
  for (const [name, s] of Object.entries(servers as Servers)) {
    const hasCommand = typeof s?.command === "string" && s.command !== "";
    const hasUrl = typeof s?.url === "string" && s.url !== "";
    if (hasCommand || hasUrl) valid[name] = s;
    else out.push(check(`server ${name}`, "fail", `Server "${name}" in ${source} has no command or url.`, `Add a "command" (or "url") to "${name}" in ${source}, or remove the entry.`));
  }
  if (Object.keys(valid).length > 0) out.push(check("mcp servers", "ok", `${Object.keys(valid).length} configured in ${source}`));
  return { checks: out, servers: valid };
}

/** Ask a stdio server to initialize, or fetch a url server, within the timeout. Resolves to an error text, or null when it answers. */
function probeServer(s: Servers[string], root: string, timeoutMs: number): Promise<string | null> {
  if (typeof s.url === "string") {
    return fetch(s.url, { signal: AbortSignal.timeout(timeoutMs) }).then(
      () => null,
      (e: Error) => (e.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : "connection refused or unreachable"),
    );
  }
  const sub = (v: string) => v.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string").map(sub) : [];
  const extra = s.env && typeof s.env === "object" ? Object.fromEntries(Object.entries(s.env).filter(([, v]) => typeof v === "string")) : {};
  const cwd = typeof s.cwd === "string" && s.cwd ? (isAbsolute(s.cwd) ? s.cwd : resolve(root, s.cwd)) : root;
  return new Promise((done) => {
    let settled = false;
    let buf = "";
    const child = spawn(sub(String(s.command)), args, { cwd, env: { ...process.env, ...extra } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      done(result);
    };
    const timer = setTimeout(() => finish(`no answer within ${timeoutMs / 1000}s`), timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" ? "command not found" : "could not start"));
    child.on("exit", (code) => finish(`exited early (code ${code ?? "none"})`));
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.split("\n").some((line) => line.includes('"jsonrpc"'))) finish(null);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ashlr-doctor", version: "1" } } }) + "\n");
  });
}

export async function buildDoctorReport(root: string, opts: DoctorOptions = {}): Promise<DoctorReport> {
  root = resolve(root);
  const plugin = readJson(join(root, ".claude-plugin/plugin.json"));
  const checks = installChecks(root, plugin);
  const config = configChecks(root, plugin);
  checks.push(...config.checks);
  const timeoutMs = opts.mcpTimeoutMs ?? 5000;
  const names = Object.keys(config.servers);
  const answers = await Promise.all(names.map((n) => probeServer(config.servers[n]!, root, timeoutMs)));
  names.forEach((n, i) => {
    const err = answers[i];
    const cmd = config.servers[n]!.command;
    checks.push(err === null
      ? check(`mcp ${n}`, "ok", "answered")
      : check(`mcp ${n}`, "fail", `Server "${n}" is unreachable: ${err}.`,
        err === "command not found" ? `Install "${String(cmd)}" so it is on your PATH: npm install -g ashlr-plugin` : `Restart your editor, then run ashlr-plugin doctor again.`));
  });
  return { schemaVersion: 1, ok: checks.every((c) => c.status !== "fail"), root, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  return [`ashlr doctor: ${report.ok ? "ok" : "issues found"}`,
    `Plugin folder: ${report.root}`,
    ...report.checks.flatMap((c) => [`${mark[c.status]} ${c.name}: ${c.detail}`, ...(c.fix && c.status !== "ok" ? [`     Fix: ${c.fix}`] : [])]),
  ].join("\n") + "\n";
}
