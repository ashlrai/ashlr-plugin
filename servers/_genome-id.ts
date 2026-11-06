/**
 * _genome-id.ts — shared genomeId shape validation.
 *
 * A genomeId arrives from the API server, a committed `.cloud-id` file, an
 * env var, or CLI argv — i.e. it is always downstream-controlled data. It is
 * used as a filename component (team-keys/, genome-vclock/) and as a URL path
 * segment (/genome/:id/...), so it must never carry separators, parent
 * segments, or URL metacharacters. Without this check a hostile server
 * response or poisoned .cloud-id like "../../x" escapes the key dir
 * (path traversal) or rewrites the request path (SSRF path traversal).
 */

// Letters, digits, dot, underscore, dash — covers uuid/nanoid-style ids while
// excluding every path and URL metacharacter (/, \, ?, #, %, @, whitespace).
export const GENOME_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** True when `id` is safe to use as a filename component or URL path segment. */
export function isSafeGenomeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    GENOME_ID_PATTERN.test(id) &&
    id !== "." &&
    id !== ".."
  );
}

/**
 * Return `id` unchanged when it is a safe genomeId, else throw.
 * For call sites that treat a malformed id as a hard error (CLI tools).
 */
export function assertGenomeId(id: unknown): string {
  if (!isSafeGenomeId(id)) {
    throw new Error("genomeId is not a safe identifier");
  }
  return id;
}

/**
 * genomeId as a URL path segment: validated AND percent-encoded, so even a
 * hypothetical id passing the pattern can never alter the request path.
 * Throws on unsafe input — callers should gate with isSafeGenomeId first.
 */
export function genomeIdPathSegment(id: unknown): string {
  return encodeURIComponent(assertGenomeId(id));
}
