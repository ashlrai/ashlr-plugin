---
name: ashlr-tier
description: Three-phase tiered delegation — explore (haiku) → implement (sonnet) → integration-check (haiku). Routes each phase to the right model tier automatically.
argument-hint: "<task>"
---

Run a task through three model tiers in sequence, each phase feeding the next.

## Usage

```
/ashlr-tier <task>
```

## How it works

| Phase | Agent | Model tier | Role |
|-------|-------|------------|------|
| 1 — Discovery | `ashlr:ashlr:explore` | haiku | Map relevant files, understand current state, surface risks |
| 2 — Implementation | `ashlr:ashlr:code` | sonnet | Implement the change using Phase 1 findings |
| 3 — Integration check | `ashlr:ashlr:plan` | haiku | Verify the implementation is consistent, surfaces integration risks |

## Examples

```
/ashlr-tier add rate limiting to the HTTP server
/ashlr-tier refactor the genome pipeline to use streaming
/ashlr-tier extract the summarization logic into a shared helper
```

## Steps

1. If `$ARGUMENTS` is empty, print usage and stop.

2. **Phase 1 — Discovery** (spawn `ashlr:ashlr:explore`):

   Prompt:
   ```
   Discovery phase for task: <task>

   1. Map all files that will need to change or be understood.
   2. Identify the entry points, key functions, and data flows involved.
   3. Surface any gotchas, risks, or constraints the implementer must know.
   4. List any existing utilities or patterns that should be reused.

   Output the standard explore shape (What / Key files / Flow / Gotchas / Unknowns). Stay under 400 words.
   ```

   Wait for completion. Capture output as `<phase1_output>`.

3. **Phase 2 — Implementation** (spawn `ashlr:ashlr:code`):

   Prompt:
   ```
   Implementation phase for task: <task>

   Phase 1 discovery findings:
   <phase1_output>

   Using the above findings:
   1. Implement the task.
   2. Follow existing patterns and reuse utilities identified in Phase 1.
   3. Handle the risks and constraints called out above.
   4. Run tests after making changes.

   Report: files changed, summary of changes, test results.
   ```

   Wait for completion. Capture output as `<phase2_output>`.

4. **Phase 3 — Integration check** (spawn `ashlr:ashlr:plan`):

   Prompt:
   ```
   Integration check for task: <task>

   Phase 2 implementation summary:
   <phase2_output>

   Review the implementation for:
   1. Interface consistency — are all callers of changed functions still compatible?
   2. Missing edge cases — what inputs/states weren't tested?
   3. Integration risks — what other system components could be affected?
   4. Follow-up tasks needed before this is production-ready.

   Output: verdict (Ready / Needs work / Blocked), top 3 risks with file:line citations, recommended follow-ups.
   ```

   Wait for completion. Capture output as `<phase3_output>`.

5. Print final report:

   ```
   ## /ashlr-tier — <task>

   ### Phase 1: Discovery (explore / haiku)
   <phase1_output>

   ### Phase 2: Implementation (code / sonnet)
   <phase2_output>

   ### Phase 3: Integration check (plan / haiku)
   <phase3_output>

   ---
   Verdict: <extracted from phase3>
   ```
