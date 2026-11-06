/** Editorial claims are rendered with their sources, never as unsourced copy. */
export interface Claim {
  heading: string;
  text: string;
  sources: readonly { href: string; label: string }[];
}

export interface UseCase {
  slug: string;
  title: string;
  description: string;
  scenario: string;
  claims: readonly Claim[];
  steps: readonly string[];
  prompt: string;
}

const CODE = "https://github.com/ashlrai/ashlr-plugin/blob/e17e8f29168b8afb0775ec6c7750ef94fb8e92d6";

export const useCases: readonly UseCase[] = [
  {
    slug: "targeted-code-reading",
    title: "Read the code that matters for a change",
    description: "Plan a search-first code review with Ashlr's grep and read tools, and learn when a compact read needs a closer look.",
    scenario: "You need to change a handler in a large repository. Start with a narrow question: where is the handler defined, and which callers depend on it?",
    claims: [
      {
        heading: "Locate the relevant matches",
        text: "ashlr__grep accepts a pattern and a working directory (cwd). The registered tool describes genome-aware retrieval when an index exists and a ripgrep fallback otherwise. Start with a specific pattern and directory rather than a repository-wide search.",
        sources: [{ href: `${CODE}/servers/efficiency-server-handlers.ts#L69-L89`, label: "Registered grep inputs and fallback behavior" }],
      },
      {
        heading: "Treat compact reads as a starting point",
        text: "ashlr__read preserves the head and tail of large files while eliding the middle. Its bypassSummary option skips model summarization but still returns snip-compacted content; it is not a full-file escape hatch. Use your host's native range reader when you need an omitted region before editing.",
        sources: [{ href: `${CODE}/servers/efficiency-server-handlers.ts#L39-L59`, label: "Registered read behavior and bypassSummary semantics" }],
      },
      {
        heading: "Check your own session ledger",
        text: "The savings guide distinguishes benchmark results from session accounting and explains that small files may remain unchanged. Check the per-tool session breakdown rather than treating a benchmark percentage as a promise about the cost of your entire task.",
        sources: [{ href: "/docs/concepts/savings-math", label: "Savings methodology and limitations" }],
      },
    ],
    steps: ["Install the plugin for your host using the installation guide below.", "Search within the relevant directory before opening entire files.", "Inspect matching files and surrounding control flow, using your host's native range reader for any elided region, then make and test the change."],
    prompt: "Use ashlr__grep with cwd set to src/ to locate the request handler. Read the matching files with ashlr__read. If the relevant code is elided, use the host's native range reader before proposing an edit.",
  },
  {
    slug: "understand-unfamiliar-repositories",
    title: "Find your way around an unfamiliar repository",
    description: "Use a project tree and a focused orientation question to plan your first change, then verify the discovered code paths.",
    scenario: "You have a bug report but no map of the codebase. Write down the behavior you want to trace, such as how a request reaches storage, before exploring files.",
    claims: [
      {
        heading: "Start with the repository structure",
        text: "ashlr__tree accepts a depth limit and a regex pattern filter. In a Git repository it uses git ls-files; outside Git it walks directories with an exclusion set. Use that structural view to choose a narrower area to investigate.",
        sources: [{ href: `${CODE}/servers/tree-server-handlers.ts`, label: "Tree implementation and registered filters" }],
      },
      {
        heading: "Ask a concrete architecture question",
        text: "ashlr__orient combines a tree scan, file discovery, compact reads and local model synthesis. Its registered inputs are query, dir and a depth of quick or thorough. Use the discovered paths as leads to inspect, not as a substitute for reading the code.",
        sources: [{ href: `${CODE}/servers/orient-server-handlers.ts#L13-L45`, label: "Registered orientation workflow and inputs" }],
      },
      {
        heading: "Verify before changing behavior",
        text: "Orientation uses compacted file reads, which can omit the middle of a file. Follow the discovered paths and use your host's native range reader to inspect any omitted code before deciding where a fix belongs.",
        sources: [{ href: `${CODE}/servers/orient-server-handlers.ts`, label: "Orientation discovery" }, { href: `${CODE}/servers/efficiency-server-handlers.ts#L39-L59`, label: "What compact reads preserve" }],
      },
    ],
    steps: ["Install and verify the plugin for your coding host.", "Ask for a shallow tree and identify the directories relevant to the report.", "Ask one architecture question, inspect the cited paths, and write a short change plan with tests."],
    prompt: "Use ashlr__tree to map this project, then ask ashlr__orient how an incoming request reaches persistence. Show the discovered paths and identify which ones need a closer read.",
  },
  {
    slug: "resume-coding-sessions",
    title: "Prepare a useful coding-session handoff",
    description: "Capture branch context before ending a Claude Code session and understand what Ashlr's resume log can and cannot recover.",
    scenario: "You are stopping halfway through a change. Leave the next session an explicit goal, a record of validation and the unresolved decisions, alongside the repository snapshot.",
    claims: [
      {
        heading: "Capture a repository snapshot",
        text: "In Claude Code, /ashlr-handoff is an alias for the dashboard handoff mode. It prints branch state, recent commits, genome status and tool usage as plain text for the next session.",
        sources: [{ href: "/docs/skills/handoff", label: "Handoff command and output" }],
      },
      {
        heading: "Resume from the available log",
        text: "/ashlr-resume summarizes the most recent session, with an optional branch argument. It reads the active session log and rotated backups without modifying them. When no log exists, it reports that no prior sessions were found.",
        sources: [{ href: "/docs/skills/resume", label: "Resume usage and missing-log behavior" }],
      },
      {
        heading: "Write down what the log cannot recover",
        text: "The resume log records tool names and working directories, not individual file paths, search strings or shell commands. Add the exact files, tests and remaining decisions to your handoff yourself; the activity summary cannot reconstruct them.",
        sources: [{ href: "/docs/skills/resume", label: "Session-log limitations" }],
      },
    ],
    steps: ["Install the Claude Code integration using the host-specific guide.", "Run /ashlr-handoff before stopping and append your goal, changed files, test results and next step.", "In the next session, run /ashlr-resume and verify the current branch and working tree before continuing."],
    prompt: "/ashlr-handoff\n\nAppend: goal, files changed, tests run and their results, unresolved decisions, and the next concrete step. Do not include credentials or private command arguments.",
  },
];
