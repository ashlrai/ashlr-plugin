import { describe, expect, test } from "bun:test";
import { documentationText, plainDocumentation, productText, type ProductTextData } from "../site/lib/product-text";

const product: ProductTextData = {
  version: "9.8.7",
  release: { version: "9.8.7", date: "2026-10-26", notes: "Release source notes." },
  install: {
    bootstrap: "source bootstrap",
    npm: "source npm install",
    claude: "source claude install\nsource reload",
    codex: "source codex install",
    cursor: "source cursor install",
    goose: "source goose install",
  },
  tools: [
    { name: "ashlr__new_tool", description: "Current registry description." },
    { name: "ashlr__optional", description: "Optional tool.", enableEnv: "ASHLR_OPTIONAL" },
  ],
  commands: [{ name: "ashlr-current", description: "Current command description." }],
  workflowSkills: [{ name: "ashlr-current-skill", description: "Current source workflow." }],
  counts: { mcpTools: 1, slashCommands: 1 },
};

describe("machine-readable product facts", () => {
  test("renders source versions, release notes, installs, tools, and commands", () => {
    const text = productText(product);
    expect(text).toContain("Current release: v9.8.7");
    expect(text).toContain("2026-10-26");
    expect(text).toContain(product.release.notes);
    for (const host of ["npm", "claude", "codex", "cursor", "goose"] as const) {
      expect(text).toContain(product.install[host]);
    }
    expect(text).toContain("`ashlr__new_tool`: Current registry description.");
    expect(text).toContain("`ashlr__optional` [requires ASHLR_OPTIONAL=1]");
    expect(text).toContain("1 enabled by default");
    expect(text).toContain("`/ashlr-current`: Current command description.");
    expect(text).toContain("Workflow skills (1)");
    expect(text).toContain("`ashlr-current-skill`: Current source workflow.");
  });

  test("new source facts replace old facts without page edits", () => {
    const changed = productText({
      ...product,
      version: "9.8.8",
      install: { ...product.install, codex: "replacement codex command" },
      commands: [{ name: "/ashlr-next", description: "New command." }],
    });
    expect(changed).toContain("Current release: v9.8.8");
    expect(changed).not.toContain("Current release: v9.8.7");
    expect(changed).toContain("replacement codex command");
    expect(changed).not.toContain("source codex install");
    expect(changed).toContain("`/ashlr-next`");
    expect(changed).not.toContain("//ashlr-next");
  });
});

describe("full documentation corpus", () => {
  test("includes actual generated documentation bodies and links", () => {
    const text = documentationText([{
      title: "Install",
      url: "/docs/install",
      description: "Install from source.",
      content: "## Required setup\n\nA body absent from metadata.",
    }], "https://example.com");
    expect(text).toContain("https://example.com/docs/install");
    expect(text).toContain("A body absent from metadata.");
  });

  test("removes MDX markup without destroying fenced commands or angle placeholders", () => {
    const command = "```sh\nrun <path> --key <KEY>\n```";
    const text = plainDocumentation(`import Example from './example';\n<Callout>\nUseful prose.\n</Callout>\n${command}`);
    expect(text).not.toContain("import Example");
    expect(text).not.toContain("<Callout>");
    expect(text).toContain("Useful prose.");
    expect(text).toContain(command);
  });
});
