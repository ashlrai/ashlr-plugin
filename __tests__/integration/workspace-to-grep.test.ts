/**
 * End-to-end integration: workspace discovery → genome section →
 * retrieval layer.
 *
 * Proves that when `runInit` (non-minimal) discovers child projects and
 * writes a `knowledge/workspace.md` section into the manifest, that
 * section is actually *retrievable* through `retrieveSectionsV2` — the
 * entry point ashlr__grep uses to pick RAG context.
 *
 * If workspace.md is on disk but not indexed in the manifest, or the
 * manifest entry has no tags that match typical queries, retrieval will
 * return nothing and the agent gets zero benefit from the discovery run.
 * This test catches that failure mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runInit } from "../../scripts/genome-init";
import {
  loadManifest,
  retrieveSectionsV2,
} from "@ashlr/core-efficiency/genome";

let workspaceDir: string;

function mkChild(name: string, opts: { claudeMd?: string; remote?: string } = {}): string {
  const p = join(workspaceDir, name);
  mkdirSync(p, { recursive: true });
  if (opts.claudeMd) {
    writeFileSync(join(p, "CLAUDE.md"), opts.claudeMd, "utf-8");
  }
  if (opts.remote) {
    execSync("git init -q", { cwd: p });
    execSync(`git remote add origin ${opts.remote}`, { cwd: p });
  }
  return p;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "ashlr-ws-grep-test-"));
});

afterEach(() => {
  if (workspaceDir && existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("workspace.md is written and indexed in the manifest", () => {
  test("runInit (non-minimal) on a populated workspace writes workspace.md + manifest section", async () => {
    // Three children: two with CLAUDE.md (so workspace rendering has context),
    // one plain. One of them has a GitHub remote so we pick up an org tag.
    mkChild("proj-a", {
      claudeMd: "# proj-a\n\nA TypeScript library for widget processing.\n",
      remote: "https://github.com/acme/proj-a.git",
    });
    mkChild("proj-b", {
      claudeMd: "# proj-b\n\nA Python service owned by the acme org.\n",
      remote: "git@github.com:acme/proj-b.git",
    });
    mkChild("proj-c");

    await runInit({
      dir: workspaceDir,
      force: false,
      minimal: false,
      summarize: false,
    });

    // On disk?
    const wsPath = join(
      workspaceDir,
      ".ashlrcode",
      "genome",
      "knowledge",
      "workspace.md",
    );
    expect(existsSync(wsPath)).toBe(true);
    const wsContent = readFileSync(wsPath, "utf-8");
    expect(wsContent).toContain("# Workspace");
    expect(wsContent).toContain("acme");

    // In the manifest?
    const manifest = await loadManifest(workspaceDir);
    expect(manifest).not.toBeNull();
    const wsSection = manifest!.sections.find(
      (s) => s.path === "knowledge/workspace.md",
    );
    expect(wsSection).toBeDefined();
    expect(wsSection!.tags).toContain("workspace");
    // Org name should be carried as a tag so org-scoped queries retrieve it.
    expect(wsSection!.tags).toContain("acme");
  });
});

describe("retrieveSectionsV2 surfaces the discovered workspace section", () => {
  test("query 'workspace' retrieves the workspace section", async () => {
    mkChild("a", { claudeMd: "# a\n\nFoo.\n" });
    mkChild("b", { claudeMd: "# b\n\nBar.\n" });
    mkChild("c");
    await runInit({
      dir: workspaceDir,
      force: false,
      minimal: false,
      summarize: false,
    });

    const sections = await retrieveSectionsV2(workspaceDir, "workspace", 4000);
    const paths = sections.map((s) => s.path);
    expect(paths).toContain("knowledge/workspace.md");
  });

  test("query by org name retrieves the workspace section", async () => {
    mkChild("widget", {
      claudeMd: "# widget\n\nAcme widget tooling.\n",
      remote: "https://github.com/acme/widget.git",
    });
    mkChild("gadget", {
      claudeMd: "# gadget\n\nAcme gadget tooling.\n",
      remote: "git@github.com:acme/gadget.git",
    });
    await runInit({
      dir: workspaceDir,
      force: false,
      minimal: false,
      summarize: false,
    });

    // Query by the org name — workspace.md has "acme" as a tag, so it should
    // score highly regardless of the other sections' content.
    const sections = await retrieveSectionsV2(workspaceDir, "acme", 4000);
    const paths = sections.map((s) => s.path);
    expect(paths).toContain("knowledge/workspace.md");
  });

  test("retrieved workspace section's content matches what was written to disk", async () => {
    mkChild("only-project", { claudeMd: "# only\n\nA lone project.\n" });
    await runInit({
      dir: workspaceDir,
      force: false,
      minimal: false,
      summarize: false,
    });

    const sections = await retrieveSectionsV2(workspaceDir, "workspace", 4000);
    const ws = sections.find((s) => s.path === "knowledge/workspace.md");
    expect(ws).toBeDefined();
    // The retrieved content is the file on disk — no transformations.
    expect(ws!.content).toContain("# Workspace");
    expect(ws!.content).toContain("only-project");
  });

  test("workspace section is absent when there are no child projects", async () => {
    // Empty workspace (no child dirs) — renderWorkspaceMd returns a valid
    // document but runInit skips writing it because graph.projects is empty.
    await runInit({
      dir: workspaceDir,
      force: false,
      minimal: false,
      summarize: false,
    });

    const manifest = await loadManifest(workspaceDir);
    const wsSection = manifest!.sections.find(
      (s) => s.path === "knowledge/workspace.md",
    );
    expect(wsSection).toBeUndefined();

    // Correspondingly, retrieval should not surface it.
    const sections = await retrieveSectionsV2(workspaceDir, "workspace", 4000);
    expect(sections.map((s) => s.path)).not.toContain("knowledge/workspace.md");
  });
});
