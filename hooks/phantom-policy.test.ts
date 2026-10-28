import { describe, expect, test } from "bun:test";
import { checkHardLimits } from "./phantom-policy.ts";

const shell = (command: string) => checkHardLimits("Bash", { command });

describe("Phantom hard limits", () => {
  for (const command of [
    "git push --force origin main",
    "git -C repo push origin main --force-with-lease",
    "git push --force-with-lease=refs/heads/main:abc origin main",
    "git push --force-if-includes origin main",
    "git push -fu origin main",
    "git push origin +HEAD:main",
    "git push --mirror origin",
    "git status && git push -f origin main",
    "echo ok; /usr/bin/git push --force origin main",
    "git push origin main\ngit push origin +refs/heads/main:main",
    "g'it' p\\ush --force origin main",
    "git p\\\nush --force origin main",
    "bash -c 'git push --force origin main'",
    'pwsh -Command "git push -f origin main"',
  ]) test(`denies ${command}`, () => {
    expect(shell(command)).toEqual({ decision: "deny", decider: "person", reason: "Force push is forbidden." });
  });

  for (const command of [
    "gh pr merge 42 --admin",
    "gh -R ashlrai/plugin pr merge --admin=true 42",
    "git status; gh pr merge 42 --admin --squash",
    "command gh pr merge --admin 42",
  ]) test(`denies admin bypass: ${command}`, () => {
    expect(shell(command)?.decision).toBe("deny");
    expect(shell(command)?.decider).toBe("person");
  });

  for (const command of [
    "npm publish", "bun publish --dry-run", "pnpm --filter plugin publish", "yarn npm publish",
    "cargo publish", "uv publish dist/*", "twine upload dist/*", "docker push registry/image",
    "gh release create v2.0", "gh release upload v2.0 archive.tgz",
    "git tag v2.0", "git tag -a v2.0 -m release", "git tag --delete v2.0",
    "git push origin --tags", "git push origin --follow-tags", "git push origin refs/tags/v2.0", "git push origin tag v2.0",
    "git tag --list --delete v2.0",
    "bash scripts/publish.sh --dry-run", "./scripts/publish.sh && echo done", "/tmp/publish.sh",
    "bash -c 'npm publish'", "eval 'gh release create v2.0'",
    "./scripts/publish.sh; npm publish",
  ]) test(`denies direct or disguised publishing: ${command}`, () => {
    expect(shell(command)?.decision).toBe("deny");
  });

  for (const command of ["scripts/publish.sh", "./scripts/publish.sh", "bash scripts/publish.sh", "bash ./scripts/publish.sh"]) {
    test(`publisher still requires a person: ${command}`, () => {
      expect(shell(command)?.decision).toBe("ask");
      expect(shell(command)?.decider).toBe("person");
    });
  }

  for (const command of [
    "git push origin main", "git status", "git tag --list", "git tag -v v1.0",
    "printf '%s' 'git push --force'", "echo npm publish", "echo safe # git push --force",
    "python -c 'opaque execution'", "bash -c \"$DYNAMIC_COMMAND\"", "eval \"$OPAQUE\"",
  ]) test(`requires a person for execution: ${command}`, () => {
    expect(shell(command)?.decision).toBe("ask");
    expect(shell(command)?.decider).toBe("person");
  });

  test("harmless quoted text and comments are not hard-denied", () => {
    expect(shell("printf '%s' 'git push --force'")?.decision).toBe("ask");
    expect(shell("echo safe # git push --force")?.decision).toBe("ask");
  });

  test("native reads delegate without granting allow", () => {
    for (const name of ["Read", "Grep", "Glob", "LS", "TaskGet", "TaskList"]) {
      expect(checkHardLimits(name, { file_path: "notes.md" })).toBeUndefined();
      expect(checkHardLimits({ name }, {})).toBeUndefined();
    }
  });

  test("writes, configuration, unknown tools and malformed inputs need a person", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "PowerShell", "mcp__settings__update", "unknown", null, {}, 42]) {
      expect(checkHardLimits(tool, null)).toMatchObject({ decision: "ask", decider: "person" });
    }
  });

  test("structured tools cannot force push or bypass merges", () => {
    expect(checkHardLimits("mcp__git__push", { force: true })?.decision).toBe("deny");
    expect(checkHardLimits("mcp__git__push", { force_with_lease: true })?.decision).toBe("deny");
    expect(checkHardLimits("mcp__github__merge", { admin: true })?.decision).toBe("deny");
    expect(checkHardLimits("mcp__github__merge", { bypass: true })?.decision).toBe("deny");
    expect(checkHardLimits("mcp__npm__publish", {})?.decision).toBe("deny");
  });

  test("never mutates tool inputs or includes command content in reasons", () => {
    const input = Object.freeze({ command: "git push --force origin confidential-branch" });
    const result = checkHardLimits(Object.freeze({ name: "Bash" }), input);
    expect(result?.reason).not.toContain("confidential");
    expect(input.command).toBe("git push --force origin confidential-branch");
  });
});
