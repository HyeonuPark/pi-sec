import { readFile, rm, writeFile } from "node:fs/promises";

export interface SupervisorState {
  restartRequired: boolean;
  notes: string[];
}

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

/**
 * Coordinates health and the cold-restart handshake. It never restarts the
 * process itself: core changes are committed in the workspace and applied by
 * the operator running `user-tools/update-and-restart`.
 */
export class Supervisor {
  private readonly state: SupervisorState = { restartRequired: false, notes: [] };

  requestRestart(note: string): void {
    this.state.restartRequired = true;
    this.state.notes.push(note);
  }

  get restartRequired(): boolean {
    return this.state.restartRequired;
  }

  snapshot(): SupervisorState {
    return { restartRequired: this.state.restartRequired, notes: [...this.state.notes] };
  }
}
