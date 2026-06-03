# Screenshots — ashlr v1.4.0 launch

Ordered by priority. Capture in order; use the listed commands to reproduce exactly.

---

## 1. Status line — active session

**What to show:** The Claude Code terminal footer with the ashlr status line, showing a real session counter, sparkline, and the `↑` activity indicator.

**Environment:** Terminal (iTerm2 or similar), dark or light, full-width.

**Command to reproduce:**
```bash
# Fire a few tool calls first to get a non-zero session counter
# Then the status line updates automatically within ~550ms
# Widen terminal to at least 120 columns for full display
```

**Expected visual:**
```
ashlr · 7d ▁▂▃▅▇█ · session ↑+48.2K · lifetime +2.1M
```
The gradient shimmer should be mid-sweep. The `↑` activity indicator should be lit (orange, fading to the brand dark). Sparkline should show meaningful variation across the 7 bars.

**Capture notes:** 1280px wide minimum. Retina / 2x preferred.

---

## 2. /ashlr-savings dashboard

**What to show:** The full `/ashlr-savings` ASCII output — per-tool rows, dollar amounts, sparkline, session and lifetime totals.

**Environment:** Terminal.

**Command to reproduce:**
```bash
# Inside Claude Code after a real session with tool calls:
/ashlr-savings
```

**Expected visual:**
```
Session savings  ·  ashlr-plugin v1.4.0
────────────────────────────────────────
  ashlr__read      6 calls    −42,180 tok   $0.13
  ashlr__grep      3 calls    −11,040 tok   $0.03
  ashlr__edit      2 calls     −3,200 tok   $0.01
  ─────────────────────────────────────────────
  Session total               −56,420 tok   $0.17
  Lifetime total             −284,900 tok   $0.86
  7-day sparkline   ▁▂▃▃▅▆█
```
Numbers should be real (not zero). At least 3 tools with non-zero rows.

---

## 3. /ashlr-dashboard — watch mode

**What to show:** The full ASCII dashboard with bar chart, sparklines, and projected annual line.

**Environment:** Terminal, dark preferred for contrast.

**Command to reproduce:**
```bash
bun run ~/.claude/plugins/cache/ashlr-marketplace/ashlr/1.4.0/scripts/savings-dashboard.ts --watch
```

**Expected visual:** Three tiles across the top (session / lifetime / best day), bar chart with at least 3 rows, 7-day and 30-day sparklines, the Fraunces-style projected annual line at the bottom. Colors intact — `--watch` mode live-redraws every 1.5s; capture a mid-redraw frame if possible.

---

## 4. Before/after comparison — single file

**What to show:** Side-by-side of raw vs ashlr output for `server/tests/auth.test.ts`. Demonstrates the 85% token reduction on a real file.

**Environment:** Terminal or static image composition.

**Numbers (from docs/benchmarks-v2.json):**
- Raw: 10,846 bytes / 2,709 tokens
- ashlr: 1,623 bytes / 406 tokens
- Ratio: 0.150 (85% reduction)

**Command to reproduce:**
```bash
# Raw (native Read):
# Read server/tests/auth.test.ts
# ↑ shows full file, ~10,846 bytes in context

# ashlr:
# ashlr__read { "path": "server/tests/auth.test.ts" }
# ↑ shows head + elision marker + tail, ~1,623 bytes
```

**Expected visual:** Two terminal panels. Left: raw output scrolling to show full length. Right: ashlr output — compact, with the `[... N lines elided ...]` marker visible. Token counts shown as labels below each panel.

---

## 5. Benchmarks page — browser

**What to show:** `plugin.ashlr.ai/benchmarks` with the −57% cross-language number prominent, per-tool breakdown bars, and the methodology section.

**Environment:** Browser, parchment background, 1280x800 viewport.

**Command to reproduce:**
```bash
# Navigate to: https://plugin.ashlr.ai/benchmarks
# Or locally: cd site && bun run dev, then open /benchmarks
```

**Expected visual:** The large −57% number above the fold. Per-tool bars showing read/grep/edit breakdown. The CI badge showing the last benchmark run. Methodology panel visible on scroll. Parchment grain texture intact.

**Capture notes:** Full-page screenshot preferred. Above-the-fold crop also useful as a thumbnail.

---

## 6. Compare page — browser

**What to show:** `plugin.ashlr.ai/compare` with the four-column comparison table. The ashlr column highlighted in the debit red.

**Environment:** Browser, 1440px wide preferred to show all four columns without horizontal scroll.

**Command to reproduce:**
```bash
# Navigate to: https://plugin.ashlr.ai/compare
# Or locally: cd site && bun run dev, then open /compare
```

**Expected visual:** Table with group headers (Compression / Architecture / Observability / etc.), the ashlr column with a subtle red tint, `+` marks in green for ashlr, `unknown` in muted ink for WOZCODE where data is not published.

---

## 7. Landing page hero

**What to show:** The `plugin.ashlr.ai` landing page hero — the large display number, the animated SVG terminal mock, and the install command.

**Environment:** Browser, 1440px wide.

**Command to reproduce:**
```bash
# Navigate to: https://plugin.ashlr.ai
```

**Expected visual:** The −57% number in Fraunces display weight, the stamp animation in mid-rotate, the terminal mock SVG showing the sparkline and counter. The parchment background with grain. The install command block visible below the fold.

**Capture notes:** Catch the hero at the moment the stamp-rotate animation is at ~45 degrees for the most dynamic still.
