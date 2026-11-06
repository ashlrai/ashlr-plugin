export interface FaqItem {
  question: string;
  answer: string;
}

/** Plain answers. Install commands stay in the agent index so this file does not copy them. */
export const faqs: FaqItem[] = [
  {
    question: "How does an agent start?",
    answer:
      "Install the package, call the JSON CLI, and register the MCP server for Claude Code, Cursor, or Codex. The copy-paste steps are in the agent index.",
  },
  {
    question: "Does it need an account?",
    answer: "No account required. The local tools and the savings ledger run on your machine.",
  },
  {
    question: "Does it send code anywhere?",
    answer:
      "The MCP server runs locally. Telemetry is off unless you opt in. File contents go back to the host that called the tool, the same way a built-in read would.",
  },
  {
    question: "What does a savings number mean?",
    answer:
      "It is the difference for one tool call, not the cost of a whole session. The published reference run is on the benchmarks page. Your own ledger is local.",
  },
  {
    question: "Which hosts get slash commands?",
    answer:
      "Claude Code gets slash commands, hook redirects, and the status line. Codex gets the plugin, skills, and nudge hooks. Cursor and Goose call the MCP server directly.",
  },
];
