import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { existsSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(join(ROOT, path)).text()) as T;
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn({
    cmd: ["bun", "run", "scripts/cli.ts", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, ASHLR_CONTEXT_DB_DISABLE: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("Codex plugin packaging", () => {
  test("plugin manifest points at Codex skills, hooks, and MCP config", async () => {
    const pkg = await readJson<{ version: string; bin: Record<string, string>; files: string[] }>("package.json");
    const plugin = await readJson<{
      name: string;
      version: string;
      skills: string;
      hooks: string;
      mcpServers: string;
      interface: { displayName: string; defaultPrompt: string[] };
    }>(".codex-plugin/plugin.json");

    expect(plugin.name).toBe("ashlr");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.hooks).toBe("./hooks/codex-hooks.json");
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.interface.displayName).toBe("Ashlr");
    expect(plugin.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(pkg.bin["ashlr-mcp"]).toBe("./scripts/ashlr-mcp.ts");
    expect(pkg.files).toContain(".codex/agents/");
  });

  test("Codex agent guidance is packaged separately from Claude agent prompts", async () => {
    const explorer = await Bun.file(join(ROOT, ".codex/agents/ashlr-explorer.md")).text();
    const worker = await Bun.file(join(ROOT, ".codex/agents/ashlr-worker.md")).text();

    expect(explorer).toContain("type: explorer");
    expect(explorer).toContain("ashlr__orient");
    expect(explorer).not.toContain("haiku");
    expect(explorer).not.toContain("subagent_type");
    expect(worker).toContain("type: worker");
    expect(worker).toContain("not alone in the codebase");
    expect(worker).not.toContain("sonnet");
    expect(worker).not.toContain("Task");
  });

  test(".mcp.json exposes one Codex stdio server with instructions", async () => {
    const cfg = await readJson<{
      mcpServers: Record<string, {
        command: string;
        cwd: string;
        args: unknown[];
        env: Record<string, string>;
        instructions: string;
      }>;
    }>(".mcp.json");

    expect(Object.keys(cfg.mcpServers)).toEqual(["ashlr"]);
    expect(cfg.mcpServers.ashlr.command).toBe("ashlr-mcp");
    expect(cfg.mcpServers.ashlr.args).toEqual([]);
    expect(cfg.mcpServers.ashlr.cwd).toBe(".");
    expect(cfg.mcpServers.ashlr.env).toEqual({
      ASHLR_MCP_HOST: "codex-cli",
      ASHLR_CODEX_HOOK_MODE: "nudge",
    });
    expect(cfg.mcpServers.ashlr.instructions).toContain("ashlr__read");
    expect(cfg.mcpServers.ashlr.instructions).toContain("ASHLR_ALLOW_PROJECT_PATHS");
  });

  test("Codex hooks use supported events and default to nudge mode", async () => {
    const cfg = await readJson<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }>(
      "hooks/codex-hooks.json",
    );
    const events = Object.keys(cfg.hooks).sort();
    expect(events).toEqual([
      "PostCompact",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ]);

    const commands = Object.values(cfg.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
    expect(commands.every((command) => command.startsWith("node "))).toBe(true);
    expect(commands.every((command) => !command.includes("ASHLR_MCP_HOST=codex-cli "))).toBe(true);
    expect(commands.every((command) => !command.includes("ASHLR_CODEX_HOOK_MODE:-nudge"))).toBe(true);
    expect(commands.every((command) => command.includes("${CODEX_PLUGIN_ROOT}"))).toBe(true);
    expect(commands.every((command) => !command.includes("${CLAUDE_PLUGIN_ROOT}"))).toBe(true);
    expect(commands.every((command) => command.includes("hook-bootstrap.mjs"))).toBe(true);
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "apply_patch|functions.apply_patch")?.hooks[0]?.command).toContain(
      "pretooluse-edit.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Bash|exec_command|functions.exec_command")?.hooks[0]?.command).toContain(
      "pretooluse-bash.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Read")?.hooks[0]?.command).toContain(
      "pretooluse-read.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Grep")?.hooks[0]?.command).toContain(
      "pretooluse-grep.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Glob")?.hooks[0]?.command).toContain(
      "pretooluse-glob.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Write")?.hooks[0]?.command).toContain(
      "pretooluse-write.ts",
    );
    expect(cfg.hooks.PreToolUse.find((group) => group.matcher === "Edit|MultiEdit")?.hooks[0]?.command).toContain(
      "pretooluse-edit.ts",
    );
    const postToolUse = cfg.hooks.PostToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(cfg.hooks.PostToolUse[0]?.matcher).toContain("functions.exec_command");
    expect(cfg.hooks.PostToolUse[0]?.matcher).toContain("functions.apply_patch");
    expect(cfg.hooks.PostToolUse[0]?.matcher).toContain("MultiEdit");
    expect(postToolUse.some((command) => command.includes("post-tool-use-genome.ts"))).toBe(true);
    expect(postToolUse.some((command) => command.includes("session-log-append.ts"))).toBe(true);
    expect(cfg.hooks.Stop[0]?.hooks[0]?.command).toContain("stop-accounting.ts");
  });

  test("repo-local Codex marketplace entry is installable", async () => {
    const marketplace = await readJson<{
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
        category: string;
      }>;
    }>(".agents/plugins/marketplace.json");
    const entry = marketplace.plugins.find((p) => p.name === "ashlr");

    expect(entry?.source).toEqual({ source: "local", path: "." });
    expect(entry?.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
    expect(entry?.category).toBe("Productivity");
  });
});

describe("Codex CLI commands", () => {
  test("codex-doctor --json reports the packaging health", async () => {
    const result = await runCli(["codex-doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      pluginManifest: { hasHooks: boolean };
      mcp: {
        bin: string;
        binDeclared: boolean;
        binResolvable: boolean;
        command: string;
        cwd: string;
        host: string;
        hookMode: string;
        installMode: string;
        mentionsWorkspaceAllowlist: boolean;
        sourceCheckoutCommand: string;
      };
      hooks: {
        defaultMode: string;
        bootstrapDefaultsHost: boolean;
        portableCommands: boolean;
        events: string[];
        rootVariable: string;
        hookFilesExist: boolean;
        referencedHookFiles: string[];
      };
      agents: { present: boolean; files: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.pluginManifest.hasHooks).toBe(true);
    expect(parsed.mcp).toMatchObject({
      bin: "ashlr-mcp",
      command: "ashlr-mcp",
      cwd: ".",
      host: "codex-cli",
      hookMode: "nudge",
      mentionsWorkspaceAllowlist: true,
    });
    expect(parsed.mcp.binDeclared).toBe(true);
    expect(parsed.mcp.binResolvable).toBeTypeOf("boolean");
    expect(parsed.mcp.installMode).toMatch(/package-bin|source-checkout/);
    expect(parsed.mcp.sourceCheckoutCommand).toContain("scripts/ashlr-mcp.ts");
    expect(parsed.hooks.defaultMode).toBe("nudge");
    expect(parsed.hooks.bootstrapDefaultsHost).toBe(true);
    expect(parsed.hooks.portableCommands).toBe(true);
    expect(parsed.hooks.rootVariable).toBe("CODEX_PLUGIN_ROOT");
    expect(parsed.hooks.hookFilesExist).toBe(true);
    expect(parsed.hooks.referencedHookFiles).toContain("session-log-append.ts");
    expect(parsed.hooks.events).toContain("PreToolUse");
    expect(parsed.hooks.events).toContain("SessionStart");
    expect(parsed.agents.present).toBe(true);
    expect(parsed.agents.files).toEqual(["ashlr-explorer.md", "ashlr-worker.md"]);
  });

  test("codex-install --dry-run --json does not write config", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-codex-cli-home-"));
    const result = await runCli(["codex-install", "--dry-run", "--json"], {
      HOME: home,
      ASHLR_HOME_OVERRIDE: home,
    });
    expect(result.code).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      dryRun: boolean;
      writes: Array<{ path: string; command: string; cwd: string; env: Record<string, string> }>;
      plugin: { agents: string };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.writes[0]).toMatchObject({
      path: "~/.codex/config.toml",
      command: "ashlr-mcp",
      cwd: ".",
      env: { ASHLR_MCP_HOST: "codex-cli", ASHLR_CODEX_HOOK_MODE: "nudge" },
    });
    expect(parsed.plugin.agents).toContain(".codex/agents");
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    await rm(home, { recursive: true, force: true });
  });

  test("codex-doctor and lifecycle commands do not write Claude config", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-codex-cli-home-"));
    try {
      for (const args of [
        ["codex-doctor", "--json"],
        ["codex-start", "--json"],
        ["codex-resume", "--json"],
        ["codex-end", "--json"],
      ]) {
        const result = await runCli(args, { HOME: home, ASHLR_HOME_OVERRIDE: home });
        expect(result.code).toBe(0);
      }
      expect(existsSync(join(home, ".claude"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("Codex lifecycle commands are host-neutral hints", async () => {
    for (const command of ["codex-start", "codex-resume", "codex-end"]) {
      const result = await runCli([command, "--json"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as { ok: boolean; command: string; host: string; next: string };
      expect(parsed).toMatchObject({ ok: true, command, host: "codex-cli" });
      expect(parsed.next).toContain(command === "codex-end" ? "ashlr stats" : "ashlr__");
    }
  });

  test("genome-refresh --json invokes the worker and returns a summary", async () => {
    const home = await mkdtemp(join(tmpdir(), "ashlr-codex-genome-home-"));
    const project = await mkdtemp(join(tmpdir(), "ashlr-codex-genome-project-"));
    try {
      await mkdir(join(home, ".ashlr"), { recursive: true });
      const changed = join(project, "changed.ts");
      await writeFile(changed, "export const changed = true;\n");
      await writeFile(join(home, ".ashlr", "pending-genome-refresh.txt"), changed + "\n");

      const result = await runCli(["genome-refresh", "--json", "--dry-run"], {
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        command: string;
        worker: string;
        summary: { filesProcessed: number; genomeRoots: string[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("genome-refresh");
      expect(parsed.worker).toContain("genome-refresh-worker.ts");
      expect(parsed.summary.filesProcessed).toBe(0);
      expect(parsed.summary.genomeRoots).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("Codex hook contract", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-codex-hook-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test("apply_patch PreToolUse payload emits additionalContext, not deny", async () => {
    const payload = {
      hook_event_name: "PreToolUse",
      turn_id: "turn-test",
      tool_use_id: "tool-test",
      tool_name: "apply_patch",
      tool_input: { patch: "*** Begin Patch\n*** End Patch\n" },
    };

    const proc = spawn({
      cmd: ["bun", "run", "hooks/pretooluse-edit.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_HOOK_TIMINGS: "0",
      },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__multi_edit");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("apply_patch PreToolUse honors ASHLR_CODEX_HOOK_MODE=off", async () => {
    const payload = {
      hook_event_name: "PreToolUse",
      turn_id: "turn-test",
      tool_use_id: "tool-test",
      tool_name: "apply_patch",
      tool_input: { patch: "*** Begin Patch\n*** End Patch\n" },
    };

    const proc = spawn({
      cmd: ["bun", "run", "hooks/pretooluse-edit.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_HOOK_MODE: "",
        ASHLR_CODEX_HOOK_MODE: "off",
        ASHLR_HOOK_TIMINGS: "0",
      },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("Codex exec_command PreToolUse payload emits a bash nudge when output will be verbose", async () => {
    const payload = {
      hook_event_name: "PreToolUse",
      turn_id: "turn-test",
      tool_use_id: "tool-test",
      tool_name: "functions.exec_command",
      tool_input: { cmd: "git status --short" },
    };

    const proc = spawn({
      cmd: ["bun", "run", "hooks/pretooluse-bash.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_HOOK_MODE: "",
        ASHLR_CODEX_HOOK_MODE: "nudge",
        ASHLR_HOOK_TIMINGS: "0",
      },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__bash");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("git status --short");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("Codex Read nudge uses Codex-safe tool names", async () => {
    const project = await mkdtemp(join(tmpdir(), "ashlr-codex-read-nudge-"));
    const file = join(project, "large.ts");
    await writeFile(file, "export const marker = true;\n".repeat(200));
    const payload = {
      hook_event_name: "PreToolUse",
      turn_id: "turn-test",
      tool_use_id: "tool-test",
      tool_name: "Read",
      tool_input: { file_path: file },
    };

    const proc = spawn({
      cmd: ["bun", "run", "hooks/pretooluse-read.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_HOOK_MODE: "",
        ASHLR_CODEX_HOOK_MODE: "nudge",
        ASHLR_HOOK_TIMINGS: "0",
      },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    await rm(project, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext?: string; permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("ashlr__read");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("mcp__plugin_ashlr_ashlr__");
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("session-log-append records Codex as codex-cli", async () => {
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "codex-session-1",
      turn_id: "turn-test",
      tool_use_id: "tool-test",
      tool_name: "mcp__ashlr__ashlr__read",
      tool_input: { path: "src/index.ts" },
      tool_response: { content: "compact output" },
    };

    const proc = spawn({
      cmd: ["bun", "run", "hooks/session-log-append.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_SESSION_LOG: "1",
      },
    });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    const log = await Bun.file(join(home, ".ashlr", "session-log.jsonl")).text();
    const rec = JSON.parse(log.trim()) as { agent: string; tool: string; session: string; input_size: number; output_size: number };
    expect(rec.agent).toBe("codex-cli");
    expect(rec.tool).toBe("mcp__ashlr__ashlr__read");
    expect(rec.session).toBe("codex-session-1");
    expect(rec.input_size).toBeGreaterThan(0);
    expect(rec.output_size).toBeGreaterThan(0);
  });

  test("subagent-stop-rollup accepts Codex agent payload fields", async () => {
    const { buildRollupLine } = await import("../hooks/subagent-stop-rollup");
    const line = buildRollupLine({
      taskId: "agent-123",
      subagentSessionId: "codex-sub-session",
      agentId: "agent-123",
      agentType: "explorer",
      summary: { tokensSaved: 200, calls: 3, topTool: "ashlr__grep" },
      ts: "2026-01-01T00:00:00.000Z",
    });

    expect(line.task_id).toBe("agent-123");
    expect(line.subagent_session_id).toBe("codex-sub-session");
    expect(line.agent_id).toBe("agent-123");
    expect(line.agent_type).toBe("explorer");
  });

  test("hook-bootstrap supplies Codex host and nudge defaults without shell env syntax", async () => {
    const project = await mkdtemp(join(tmpdir(), "ashlr-codex-bootstrap-"));
    const hook = join(project, "print-env.ts");
    await writeFile(
      hook,
      "console.log(JSON.stringify({ host: process.env.ASHLR_MCP_HOST, mode: process.env.ASHLR_HOOK_MODE }));\n",
    );

    const proc = spawn({
      cmd: ["node", "scripts/hook-bootstrap.mjs", hook],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CODEX_PLUGIN_ROOT: ROOT,
        CLAUDE_SESSION_ID: "",
        CLAUDE_CODE_MODEL: "",
        ASHLR_MCP_HOST: "",
        ASHLR_HOOK_MODE: "",
        ASHLR_CODEX_HOOK_MODE: "",
      },
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    await rm(project, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ host: "codex-cli", mode: "nudge" });
  });
});

describe("ashlr-mcp launcher", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ashlr-codex-mcp-home-"));
    project = await mkdtemp(join(tmpdir(), "ashlr-codex-mcp-project-"));
    await mkdir(join(home, ".ashlr"), { recursive: true });
    await writeFile(join(project, "sample.txt"), "hello from codex launcher\n");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(project, { recursive: true, force: true }).catch(() => {});
  });

  test("starts router, lists tools, and reads an allow-listed workspace file", async () => {
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-test", version: "1" } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ashlr__read", arguments: { path: join(project, "sample.txt") } },
      },
    ];

    const proc = spawn({
      cmd: ["bun", "run", "scripts/ashlr-mcp.ts"],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        ASHLR_HOME_OVERRIDE: home,
        ASHLR_MCP_HOST: "codex-cli",
        ASHLR_ALLOW_PROJECT_PATHS: project,
        ASHLR_STATS_SYNC: "1",
        ASHLR_SESSION_LOG: "0",
      },
    });
    proc.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await proc.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(stderr).toContain("host=codex-cli");
    expect(existsSync(join(home, ".claude"))).toBe(false);

    const responses = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as any);
    expect(responses.find((r) => r.id === 1)?.result?.serverInfo?.name).toBe("ashlr-router");
    const names = responses.find((r) => r.id === 2)?.result?.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("ashlr__read");
    expect(responses.find((r) => r.id === 3)?.result?.content?.[0]?.text).toContain("hello from codex launcher");
  }, 20_000);
});
