import { readFile, rm, writeFile } from "node:fs/promises";

/** Read the recorded daemon PID, if any. */
export async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with `pid` is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writePid(pidFile: string, pid = process.pid): Promise<void> {
  await writeFile(pidFile, `${pid}\n`, { mode: 0o600 });
}

export async function removePid(pidFile: string): Promise<void> {
  await rm(pidFile, { force: true });
}
