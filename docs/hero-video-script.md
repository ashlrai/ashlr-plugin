# Hero video script — ashlr v1.4.0

Shooter's brief. 30 seconds. No narration. Terminal + browser + minimal type captions.
Aspect ratio 16:9. Export at 1080p minimum.

---

## Shot list

### 0:00 – 0:05 | Terminal — savings command

**Setup:** Clean terminal, dark background, JetBrains Mono or similar. No clutter in prompt.

**Action:**
```
$ /ashlr-savings
```
Output renders smoothly — the ASCII dashboard animates in, showing per-tool rows, the 7-day sparkline, session total, lifetime total.

**Caption (lower-left, monospaced, small):**
```
/ashlr-savings
```

**Notes:** Use a session with real numbers. Session total should be at least 40K tokens for visual impact. Record at 1x speed; do not speed up. Let the render finish before cut.

---

### 0:05 – 0:10 | Terminal — status line

**Setup:** Same terminal session. Scroll past the dashboard output or open a new pane showing the status line in the Claude Code footer.

**Action:** Status line is visible and animating:
```
ashlr · 7d ▁▂▃▅▇█ · session ↑+100K · lifetime +4.3M
```
The gradient shimmer sweeps left to right. The `↑` activity indicator is lit (fire a tool call to trigger it if needed).

**Caption:**
```
live session counter · 7-day sparkline
```

**Notes:** Record at real speed; the animation cycle is 120 ms per frame. The gradient sweep should be visible. If the terminal is too narrow to show the full line, widen it before recording.

---

### 0:10 – 0:15 | Terminal — edit with live counter

**Setup:** Same terminal. Open a source file in Claude Code or simulate an `ashlr__edit` call.

**Action:** Run an edit on a medium-sized file (200+ char search string). As the edit completes, the status line counter ticks up visibly — the `↑` indicator appears and the session number increments.

**Caption:**
```
counter updates within ~550ms of each tool call
```

**Notes:** The increment should be visible on screen — choose a file where the edit saves at least 500 tokens. The key visual is the `↑` appearing and the number changing.

---

### 0:15 – 0:20 | Terminal — dashboard

**Setup:** New terminal frame or continuation.

**Action:**
```
$ /ashlr-dashboard
```
The full ASCII dashboard renders: wordmark banner, three CountUp tiles (session / lifetime / best day), per-tool horizontal bar chart, 7-day and 30-day sparklines, projected annual line in Fraunces italic (simulated in terminal with the actual output).

**Caption:**
```
/ashlr-dashboard
```

**Notes:** Use `--watch` mode if the recording is long enough (it redraws every 1.5s). Otherwise a static render is fine. Ensure the bar chart has at least 3 tools with visible bars.

---

### 0:20 – 0:25 | Browser — landing page

**Setup:** Browser, clean tab, navigate to `plugin.ashlr.ai`. No bookmarks bar visible. Window at 1280x800 minimum.

**Action:** The landing page loads. Scroll slowly past:
1. Hero with the `−57%` number
2. The before/after bytes comparison animation (let it play)
3. The animated SVG terminal mock in the hero

**Caption:**
```
plugin.ashlr.ai
```

**Notes:** Let the before/after animation complete at least once. Do not scroll faster than the animations. The parchment grain texture and the stamp rotate-in on the final percentage are the key visual moments.

---

### 0:25 – 0:30 | Browser + terminal — install + tagline

**Setup:** Split or sequence: browser showing `plugin.ashlr.ai/benchmarks` with the −57% bar chart, then cut to terminal.

**Browser action (0:25 – 0:27):**
Navigate to `plugin.ashlr.ai/benchmarks`. The −57% cross-language bar is visible. Pause 2 seconds.

**Terminal action (0:27 – 0:30):**
```
$ curl -fsSL plugin.ashlr.ai/install.sh | bash
```
Installation output begins to scroll.

**Caption (centered, Fraunces, large, fades in over install output):**
```
ship less context.
```

**Notes:** The tagline card should appear as the install command fires — the juxtaposition of "running the thing" with the headline is the intended close. Fade to black on the tagline, not on the terminal output.

---

## General notes

- **No narration.** Captions only. Keep them in JetBrains Mono at 11–13px equivalent in the video.
- **Music:** Optional ambient/lo-fi. If used: −18 LUFS integrated, fade out before final tagline card.
- **Color:** Parchment palette — `#F3EADB` background, `#8B2E1A` accent. Terminal can be dark.
- **Transitions:** Cut only. No dissolves, no wipes.
- **Duration:** 30 seconds hard. Do not pad.
- **Export:** H.264, 1080p, 60fps. Separate 4K master if available.
