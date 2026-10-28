# Findings: RQ-DFPLUGINQ8

- Initial HEAD: 0d408a2; origin HEAD verified with git ls-remote.
- Initial worktree clean; existing branch codex-bridge/RQ-DFPLUGINQ8.
- gh failed before authentication: config read denied. Empty alternate config has no auth. Public log endpoint returns HTTP 403.
- Public jobs API confirms linux Unit tests failure and downstream CI Gate failure; other-os and integration-windows skipped, fast/secret-shape/benchmark successful.
- Linux annotations (scrubbed through existing contrib/mac-bridge/scrub.pl) identify resolve-mr-conflicts.test.ts:166: frozen Bun install preserved the artificial file:vendor/lp#main lockfile edit.
- Real fix: fixture manifest gains a new local dependency absent from the lockfile, forcing actual regeneration. All assertions retained, new dependency assertion added.
- Dependencies installed with frozen lockfile. Typecheck and mdx lint pass. Focused tests pass 2/2 with --timeout 30000; baseline default timeout was insufficient on this host.
- Coverage annotations confirm identical failure in separate run 40726414760.
- Original test passes locally with 30s timeout on Bun 1.3.14; CI assertion reproduction is annotation-backed, not local.
- SonarCloud also failed independently on source SHA; conditions recorded in BRIDGE_NOTES.md.
