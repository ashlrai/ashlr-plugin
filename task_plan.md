# Task Plan: RQ-FIXUP-CIFAILQ8

## Goal
Investigate main CI without duplicating guardian fixes.

## Phases
- [x] Read repository instructions and install frozen dependencies.
- [x] Inspect available main and guardian commits; record blocked live GitHub access.
- [x] Confirm the root cause is already repaired by #1191 and covered by #1192.
- [x] Run typecheck, lint, and affected tests; write BRIDGE_NOTES.md.

## Decision
Use the user's duplicate-work exception: leave no code, workflow, or test changes.

## Errors encountered
- Locus GitHub reads refuse an expired session. Recovery returns Operation not permitted.
- Locus doctor reports inaccessible bindings and a retired authority broker.
- A test command including temporary-directory cleanup was rejected before execution;
  reran with temporary HOME and no shell cleanup.

## Status
Duplicate coverage documented; local validation passes; live CI status unverified.
