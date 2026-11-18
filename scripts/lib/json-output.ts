/**
 * One place for the CLI's `--json` envelope. Every command prints an object
 * whose first key is `schema`, named `ashlr-plugin.<command>.v1`, so an agent
 * can check what it is reading before it reads the rest. Fields are only ever
 * added within v1; a breaking change gets a new `.v2` name.
 */
export function schemaName(command: string): string {
  return `ashlr-plugin.${command}.v1`;
}

/** Wrap a result. Non-object results (such as a missing slice) go under `value`. */
export function withSchema(command: string, payload: unknown): Record<string, unknown> {
  const schema = schemaName(command);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const { schema: _ignored, ...rest } = payload as Record<string, unknown>;
    return { schema, ...rest };
  }
  return { schema, value: payload ?? null };
}

export function jsonText(command: string, payload: unknown): string {
  return JSON.stringify(withSchema(command, payload), null, 2) + "\n";
}
