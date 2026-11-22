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
  {
    question: "How does it fit the Ashlr ecosystem?",
    answer:
      "It is the efficiency layer. Phantom and its sibling repos form an autonomous, code-first, agent-native software factory: agents do the engineering and maintain each repo, the human sits as a passive board member, and the goal is open source RSI (recursive self-improvement). The plugin's handshake lets Phantom and other agents discover it as JSON.",
  },
  {
    question: "How do I contribute with an agent?",
    answer:
      "Hand an issue to your coding agent and let it follow AGENTS.md and CONTRIBUTING.md: branch from main, run the checks, scan the diff for secrets, and open a PR. CI Gate is the single required check, and the PR lands through the merge queue once it is green. From a fork, a maintainer arms auto-merge.",
  },
];
