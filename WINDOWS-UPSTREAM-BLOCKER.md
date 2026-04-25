# Windows Upstream Blocker — Track E / v1.21

## Status: ALREADY FIXED in installed package

The memory note describing this blocker was written before the fix landed.

**Verified 2026-04-24:**
`node_modules/@ashlr/core-efficiency/src/genome/manifest.ts:76`
currently reads:

```ts
const gDir = genomeDir(cwd) + sep;
```

The bug (`+ '/'` instead of `+ sep`) is **not present** in the installed copy.
No upstream PR is required from this worktree.

---

## Original Bug Description (for historical reference)

`@ashlr/core-efficiency` `src/genome/manifest.ts` `sectionPath()` appended a
hardcoded `"/"` separator when building the genome directory sentinel:

```ts
// BUG (pre-fix):
const gDir = genomeDir(cwd) + "/";

// FIX:
const gDir = genomeDir(cwd) + sep;
```

On Windows, `path.join()` produces `\`-separated paths. Appending `"/"` meant
`resolved.startsWith(gDir)` would always return `false` on Windows, causing
every `sectionPath()` call to throw:

```
Invalid section path: <rel> escapes genome directory
```

This cascaded into ~25 Windows test failures across:
- `__tests__/genome-server.test.ts` (all section-path tests)
- `__tests__/genome-live.test.ts` (embed-populator calls sectionPath)
- `__tests__/genome-auto-propose.test.ts`
- `__tests__/genome-auto-consolidate.test.ts`
- `__tests__/genome-sync.test.ts`
- `__tests__/orient-server.test.ts` (orient loads genome sections)

## What Track E delivered locally (independent of upstream)

1. **`servers/test-server-handlers.ts`** — `resolveTestSpawnOptions()` helper
   returns `shell: true` on Windows so `.cmd` shims for `bunx`, `jest`,
   `vitest` are resolved by CMD.EXE. On POSIX, `detached: true` is preserved
   for process-group kill.

2. **`servers/_test-watch.ts`** — `spawnTestRun()` updated with same
   `shell: isWin` / `detached: !isWin` pattern.

3. **`servers/_cwd-clamp.ts`** — `canonical()` now captures the error code
   from the top-level `realpathSync` failure. `clampToCwd()` checks for
   non-ENOENT codes and emits:
   ```
   <tool>: path outside cwd OR realpath failed (likely symlink/jail boundary): <path> in <cwd> [<ERRCODE>]
   ```
   instead of the generic "refused path outside working directory" message.

4. **`.github/workflows/ci.yml`** — `integration-windows` job retains
   `continue-on-error: true` with an explanatory comment. The orchestrator
   flips this to `false` after confirming the Windows unit matrix is green.

5. **`__tests__/test-server-windows.test.ts`** — new tests stub
   `process.platform` to verify the `.cmd` resolution path is taken on Windows.

6. **`__tests__/cwd-clamp-jail.test.ts`** — new tests covering:
   - Normal in-cwd path (allow)
   - Normal out-of-cwd path (deny with original message)
   - Simulated realpath failure via mocked fs (new diagnostic message)
