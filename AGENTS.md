# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`phm improve --auto-merge` / `gh pr merge --auto`). A PR merges only after every required CI check is green. Never bypass a failing or pending check, and never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Reserved for Mason (owner approval required)
- Creating, moving, or deleting release tags, and publishing packages or releases.
- Rotating, creating, or exposing secrets and tokens.
- Deleting repositories, branches, or data, and changing rulesets or branch protection.
- Spending money, or anything that is billed.
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.

## Ground rules
- Keep diffs small and reviewable, with one concern per PR.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Documentation freshness
- Tool source lives in `servers/`; `server/` is the separate cloud backend. Tool names and argument schemas come from the registrations imported by `servers/_router-handlers.ts` and the generated `servers/_tool-catalog.json`.
- Slash commands come from `commands/*.md`, including non-`ashlr-` commands (`goal`, `loop`); `skills/*/SKILL.md` files are separately packaged workflow skills, not commands.
- `site/scripts/freshness.ts` (`cd site && bun run gen-docs`) regenerates the skills index, help, tools index, capabilities matrix, install/release pages and `site/lib/*.generated.json` from source. Re-run it after changing command frontmatter, the tool catalog, install commands, or release facts.
- `docs/commands.md` is the maintained command reference. Run `HOME=$(mktemp -d) bun test __tests__/docs-freshness.test.ts __tests__/command-docs.test.ts __tests__/router-lazy-handshake.test.ts` after changing tool or command documentation.
- Use `ashlr-plugin` for terminal CLI examples and `ashlr__*` names for MCP calls.
