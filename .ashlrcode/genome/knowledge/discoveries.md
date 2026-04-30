# Discoveries

Things agents have learned about the codebase and domain.

> High-signal, human-curated entries only. Raw auto-observations (JSON blobs,
> file listings, git diffs captured by the propose-loop) live in
> `discoveries-auto.md`, which is not indexed in the manifest and does not
> participate in genome retrieval. Promote entries up when they prove useful.


## Auto-observations · 2026-04-29
- [{"type":"text","text":" 1: /**\n 2: * _test-parsers — structured parsers for common test runner output.\n 3: *\n 4: * Each parser converts raw stdout+stderr into a TestResult with pass/fail/skip\n 5: * counts, duration, and per-failure details. Used by test-server-handlers.ts.\n 6: */\n 7: \n 8: export interface TestFailure {\n 9: file: string;\n 10: line?: number;\n 11: testName: string;\n 12: m…
- [{"type":"text","text":" 1: /**\n 2: * _embedding-model.ts — Pluggable embedder for the ashlr embedding cache.\n 3: *\n 4: * Day-1 strategy: BM25-style sparse pseudo-embedding via hash projection.\n 5: * - Tokenize input text (whitespace + punctuation split, lowercase).\n 6: * - Compute per-token IDF weights from a per-project corpus stored at\n 7: * ~/.ashlr/embed-corpus.json.\n 8: * - Project to…
- [{"type":"text","text":" 1: /**\n 2: * genome-auto-consolidate.test.ts — v1.13 novelty gate + v1.15 LLM synthesis.\n 3: *\n 4: * Locks in the behavior that `applyFallback` now drops proposals whose\n 5: * token-overlap against existing section lines (or prior accepted bullets\n 6: * in the same batch) exceeds the Jaccard-similarity threshold. Addresses\n 7: * the \"junk-drawer discoveries.md\" fin…
