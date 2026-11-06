import { isAbsolute, resolve } from "node:path";

/** Resolve a command before spawning it, including explicit test overrides. */
export function resolveCommand(command: string): string {
  const executable = Bun.which(command, { PATH: process.env.PATH ?? "" });
  if (!executable) throw new Error(`Executable not found: ${command}`);
  return isAbsolute(executable) ? executable : resolve(executable);
}
