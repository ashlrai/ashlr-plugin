/** Real native process fixture for the fixed `ashlr resources --json` contract. */
import { chmodSync, constants, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function installNativeMonitorFixture(bin: string, cwd: string, snapshot: string, count?: string): void {
  // A shell shim and POSIX PATH cannot exercise native Windows spawn. Reuse
  // the test's already-installed runtime, without compilation or downloads.
  const executable = join(bin, process.platform === "win32" ? "ashlr.exe" : "ashlr");
  copyFileSync(process.execPath, executable, constants.COPYFILE_EXCL);
  chmodSync(executable, 0o755);
  // The renamed Bun executes this actual owned program when the production
  // collector invokes exactly `ashlr resources --json`; wrong args fail.
  writeFileSync(join(cwd, "resources"), `
import { appendFileSync } from "node:fs";
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--json"])) process.exit(7);
${count ? `appendFileSync(${JSON.stringify(count)}, "x\\n");` : ""}
process.stdout.write(${JSON.stringify(snapshot)});
`, { flag: "wx", mode: 0o600 });
}
