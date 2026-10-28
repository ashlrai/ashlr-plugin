export interface HardLimitDecision {
  decision: "deny" | "ask";
  decider: "person";
  reason: string;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TaskGet", "TaskList"]);
const SEPARATORS = new Set([";", "|", "&", "(", ")", "\n"]);

function decision(kind: "deny" | "ask", reason: string): HardLimitDecision {
  return { decision: kind, decider: "person", reason };
}

/**
 * Recognize ordinary command spellings, including quoted words and escapes.
 * This is deliberately not a shell interpreter. Expansions, aliases, encoded
 * scripts and arbitrary code always require a person; nothing here grants allow.
 */
function words(command: string): string[] {
  const result: string[] = [];
  let word = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && quote !== "'" && i + 1 < command.length) {
      const escaped = command[++i];
      if (escaped !== "\n") word += escaped;
    } else if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (/\s/.test(c) || SEPARATORS.has(c)) {
      if (word) result.push(word);
      word = "";
      if (SEPARATORS.has(c)) result.push(c);
    } else if (c === "#" && !word) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else {
      word += c;
    }
  }
  if (word) result.push(word);
  return result;
}

const executable = (word: string): string => word.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");

function deniedCommand(command: string, depth = 0): string | undefined {
  const tokens = words(command);
  const exactPublisher = tokens.length === 1 && ["scripts/publish.sh", "./scripts/publish.sh"].includes(tokens[0]!)
    || tokens.length === 2 && tokens[0] === "bash" && ["scripts/publish.sh", "./scripts/publish.sh"].includes(tokens[1]!);

  for (let i = 0; i < tokens.length; i++) {
    const boundary = tokens.slice(0, i).findLastIndex((token) => SEPARATORS.has(token));
    const prefix = tokens.slice(boundary + 1, i);
    // An executable mentioned as an argument (e.g. echo npm publish) is text.
    // Unrecognized wrappers remain opaque and require human review below.
    if (!prefix.every((token) => ["command", "env", "exec", "sudo", "nohup", "npx", "bunx"].includes(executable(token))
      || /^[A-Za-z_][A-Za-z_0-9]*=/.test(token))) continue;
    const name = executable(tokens[i]!);
    const end = tokens.findIndex((token, index) => index > i && SEPARATORS.has(token));
    const args = tokens.slice(i + 1, end < 0 ? undefined : end);
    if (name === "publish.sh" && !exactPublisher) return "Publishing requires the exact scripts/publish.sh entrypoint without arguments or compound commands.";
    if (["bash", "sh", "zsh"].includes(name) && args.some((arg) => executable(arg) === "publish.sh")
      && !exactPublisher) return "Publishing requires the exact scripts/publish.sh entrypoint without arguments or compound commands.";
    if (name === "git") {
      const push = args.indexOf("push");
      if (push >= 0) {
        const pushArgs = args.slice(push + 1);
        if (pushArgs.some((arg) => /^--(?:force(?:-with-lease|-if-includes)?|mirror)(?:=|$)/.test(arg)
          || /^-[^-]*f/.test(arg) || arg.startsWith("+"))) return "Force push is forbidden.";
        if (pushArgs.some((arg) => arg === "--tags" || arg === "--follow-tags" || arg === "tag" || /(?:^|:)refs\/tags\//.test(arg))) return "Publishing release tags requires scripts/publish.sh.";
      }
      const tag = args.indexOf("tag");
      if (push < 0 && tag >= 0 && args.length > tag + 1
        && (args.slice(tag + 1).some((arg) => /^(?:--delete|--force|-d|-f)$/.test(arg))
          || !args.slice(tag + 1).some((arg) => /^(?:--list|--verify|-l|-v)$/.test(arg)))) {
        return "Changing release tags requires scripts/publish.sh.";
      }
    }
    if (name === "gh") {
      if (args.includes("merge") && args.some((arg) => /^--admin(?:=|$)/.test(arg))) return "Admin merge bypass is forbidden.";
      if (args.includes("release") && args.some((arg) => ["create", "upload", "delete", "edit"].includes(arg))) return "Publishing releases requires scripts/publish.sh.";
    }
    if (["npm", "bun", "pnpm", "yarn", "cargo", "uv"].includes(name) && args.includes("publish")
      || ["twine", "docker", "gem"].includes(name) && args.some((arg) => ["upload", "push"].includes(arg))) {
      return "Direct publishing is forbidden; use scripts/publish.sh.";
    }
    // Nested shell strings are common, but unknown interpreters still get ask.
    if (depth < 4 && (["bash", "sh", "zsh", "fish", "powershell", "pwsh"].includes(name)
      || name === "eval")) {
      const commandFlag = args.findIndex((arg) => /^(?:-[^-]*c|-command)$/i.test(arg));
      const script = name === "eval" ? args.join(" ") : commandFlag < 0 ? undefined : args[commandFlag + 1];
      if (script) {
        const denied = deniedCommand(script, depth + 1);
        if (denied) return denied;
      }
    }
  }
  return undefined;
}

/** Native read tools delegate to Claude's policy. Every other tool needs a person. */
export function checkHardLimits(tool: unknown, input: unknown): HardLimitDecision | undefined {
  const name = typeof tool === "string" ? tool
    : tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? tool.name : "";
  if (READ_TOOLS.has(name)) return undefined;
  const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const command = typeof input === "string" ? input : typeof payload.command === "string" ? payload.command : undefined;
  if (command) {
    const denied = deniedCommand(command);
    if (denied) return decision("deny", denied);
  }
  if (/push/i.test(name) && (payload.force === true || payload.force_with_lease === true || payload.forceWithLease === true)) return decision("deny", "Force push is forbidden.");
  if (/merge/i.test(name) && (payload.admin === true || payload.bypass === true)) return decision("deny", "Admin merge bypass is forbidden.");
  if (/(?:^|[_./-])(?:publish|release_create|release_upload)(?:$|[_./-])/i.test(name)) return decision("deny", "Direct publishing is forbidden; use scripts/publish.sh.");
  return decision("ask", "A person must review execution, writes, configuration changes and unrecognized tools.");
}
