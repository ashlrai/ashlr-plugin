// Type declarations for bun-resolve.mjs. The implementation stays as .mjs
// because scripts/bootstrap.mjs and scripts/hook-bootstrap.mjs run under
// plain node (no TypeScript loader) — they can't import a .ts/.mts source.
// TypeScript consumers (scripts/doctor.ts) resolve to this sidecar via
// bundler module resolution.

export const BUN_BIN_DIR: string;
export function bunBinaryPath(): string;
export function hasBun(): boolean;
export function prependBunToPath(): void;
export function bunBinaryOnDisk(): string | null;
