import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { pidAlive } from "../servers/_pid-alive";

describe("pidAlive", () => {
  test("own process is alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("invalid pids are not alive", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("an exited but unreaped child (zombie) is not alive", async () => {
    // child_process.spawn reaps on exit, so make a zombie one level down: a
    // shell whose own child exits while the shell stays blocked in `sleep`
    // without waiting on it.
    const sh = spawn("sh", ["-c", "true & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const zombiePid = await new Promise<number>((resolve) => {
        sh.stdout!.once("data", (d) => resolve(parseInt(String(d).trim(), 10)));
      });
      // `exec sleep` replaces the shell, so nothing reaps `true`: wait for
      // the kernel to report it as a zombie.
      let state = "";
      for (let i = 0; i < 80 && state !== "Z"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const stat = readFileSync(`/proc/${zombiePid}/stat`, "utf8");
        state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      }
      expect(state).toBe("Z");
      expect(() => process.kill(zombiePid, 0)).not.toThrow();
      expect(pidAlive(zombiePid)).toBe(false);
    } finally {
      sh.kill("SIGKILL");
    }
  });
});
