/**
 * Reference projection of Phantom's probeClaudePluginCache manifest read in
 * src/core/tools-registry.ts at e9f456132d5d5e66c9c0f3b9a7864320b03f75d5.
 * This is the Claude cache contract, not Phantom's separate manifest.json API.
 * Keep this test-only reader aligned with the consumer when updating the contract.
 */
export function readPhantomPluginManifest(
  raw: string,
  directory: string,
): { version: string | null } | null {
  try {
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (manifest["name"] !== "ashlr") return null;
    return {
      version: typeof manifest["version"] === "string"
        ? manifest["version"]
        : extractSemver(directory),
    };
  } catch {
    return null;
  }
}

// Same directory fallback as Phantom's extractSemver, including error rejection.
function extractSemver(raw: string): string | null {
  if (!raw) return null;
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?/);
  if (match) return match[0];
  const firstLine = clean.split("\n")[0]?.trim();
  if (!firstLine) return null;
  if (/error|unknown|usage|illegal|not found|command/i.test(firstLine)) return null;
  return firstLine.slice(0, 80);
}
