---
name: ashlr-codex-efficient-tools
description: Codex workflow for saving context. Prefer ashlr MCP read, grep, tree, bash, savings and genome tools over native scans when they are smaller.
---

# Ashlr Codex Efficient Tools

Use Ashlr MCP tools for high-volume context work:

- Use `ashlr__orient` once before broad exploration when a genome exists.
- Use `ashlr__grep` for search instead of repeated native scans.
- Use `ashlr__tree` for compact directory maps.
- Use `ashlr__read` for large files or files where only head/tail plus structure is needed.
- Use `ashlr__bash` for verbose commands such as tests, typechecks, `git log`, and package installs.
- Use `ashlr__savings` or `ashlr-plugin stats --json` to inspect token/cost savings.

Keep native tools for tiny files, exact patch application, or commands where raw output is short and important.
