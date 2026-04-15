# Architecture

> Auto-populated from an ashlr baseline scan at genome init. Edit freely to
> capture intent and tradeoffs that a scanner cannot see.

## Snapshot

- **Files scanned:** 87
- **Runtime:** Bun
- **Runtime notes:** package.json type=module; bun.lock present; walk: git ls-files
- **Top extensions:** .ts (35), .md (34), .json (7), .sh (3), (none) (3), .svg (2)
- **Tests:** 16 files via bun:test

## Largest source files

- `servers/bash-server.ts` — 876 LOC
- `scripts/baseline-scan.ts` — 821 LOC
- `servers/tree-server.ts` — 578 LOC

## Top-level layout

```
ashlr-plugin/
├── .ashlrcode/
├── __tests__/
├── agents/
├── commands/
├── docs/
├── hooks/
├── scripts/
├── servers/
├── skills/
├── CHANGELOG.md
├── CONTRIBUTING.md
├── FAQ.md
├── LICENSE
├── README.md
├── SECURITY.md
├── bun.lock
├── package.json
├── tsconfig.json
```

## Notes

- Replace this section with an intent-level description: why does each top-level dir exist, what does it own, and what crosses its boundary?
