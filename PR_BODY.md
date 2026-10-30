Expose every fleet control to agents and guard UI/HTTP/CLI parity

`bun scripts/fleet-surface.ts` prints a versioned JSON manifest for eight actions across eleven desktop, steering, and mobile controls, including proposal refresh. Each entry includes UI source, HTTP method/path/body, and executable CLI argv; POST headers are documented in the manifest.

Gaps found and closed:
- Pause lane: missing CLI; now `scripts/fleet-act.ts`.
- Resume lane: missing CLI; now `scripts/fleet-act.ts`.
- Kill job: missing CLI; now `scripts/fleet-act.ts`.
- Reassign job: missing controller-request CLI; now `scripts/fleet-act.ts` (steering proposals remain separate).
- Set slots: missing controller-request CLI; now `scripts/fleet-act.ts`.

The wrapper reuses existing validation, attribution, fixed-root audit safeguards, and dry-run defaults. Explicit mutations remain pending requests/proposals for controller review. No HTTP gaps remain in this scope.

Validation: 46 tests pass across six focused files with temporary HOME; typecheck and MDX lint pass. Parity tests discover actual UI declarations, reject missing mappings/surfaces, execute all HTTP/CLI examples, and verify refusal/default-preview behavior.
