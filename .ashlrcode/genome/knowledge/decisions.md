# Architectural Decision Records

> Each non-obvious decision gets an ADR entry. Append — do not rewrite history.

---

## ADR-0000: Initialize genome

- **Status:** Accepted
- **Date:** 2026-04-15
- **Context:** This project now uses an ashlr genome so the agent can route
  grep/recall through retrieval instead of re-reading files (~-84% token
  savings on repeated queries).
- **Decision:** Store durable context in `.ashlrcode/genome/` keyed by the
  manifest so retrieval stays cheap and deterministic.
- **Consequences:** Agents must keep the genome current as the project evolves.
  Stale knowledge sections degrade retrieval quality.

---

## ADR-NNNN: _Template_

- **Status:** Proposed | Accepted | Superseded
- **Date:** YYYY-MM-DD
- **Context:** …
- **Decision:** …
- **Consequences:** …
