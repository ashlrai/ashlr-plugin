import { homedir, platform } from "node:os";

/**
 * Directory that holds `~/.ashlr`.
 * Windows prefers USERPROFILE. os.homedir() ignores HOME there.
 * macOS and Linux prefer HOME.
 * `osPlatform` is an argument so tests can cover both without a Windows machine.
 */
export function userHome(env: NodeJS.ProcessEnv = process.env, osPlatform = platform()): string {
  const home = osPlatform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
  if (!home || home === "~") {
    throw new Error("Could not resolve the user home directory");
  }
  return home;
}
