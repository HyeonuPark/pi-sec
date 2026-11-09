/**
 * The order the daemon stops in, and the limit on how long it may take.
 *
 * A step that never ends (an extension cleanup that waits for a child process, a
 * connection that stays open) must not keep the process alive with its port
 * closed, its pid file and its lock held, and every later signal ignored. The
 * supervisor reads the exit code to decide what to do next, so the process always
 * ends with the code the stop chose, in time or not. The steps, the timers and
 * `exit` are passed in, so a test can drive the sequence with a step that hangs.
 */

/** How long all steps together may take, in milliseconds. A systemd unit kills the process after 30 s. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/** How long after a finished stop the process may stay alive before it ends itself, in milliseconds. */
export const EXIT_FALLBACK_MS = 2_000;

export interface ShutdownStep {
  /** The name the log lines use: "server" or "runtime". */
  readonly name: string;
  readonly run: () => Promise<void>;
  /** The line logged when the step finished. */
  readonly done: string;
}

export interface ShutdownLog {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ShutdownTimers {
  /** The handle must not keep the event loop alive. */
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ShutdownOptions {
  readonly steps: readonly ShutdownStep[];
  /** Runs after the steps, or after the deadline: remove the pid file, release the lock. */
  readonly release: () => Promise<void>;
  /** The exit code the stop chose. */
  readonly code: number;
  readonly log: ShutdownLog;
  readonly exit: (code: number) => void;
  readonly timers: ShutdownTimers;
  readonly deadlineMs?: number;
  readonly exitFallbackMs?: number;
}

/** Real timers whose handles are unreferenced. */
export const realTimers: ShutdownTimers = {
  setTimer: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Run the steps in order, then release. Resolves with the exit code once the
 * steps and the release are done. When the deadline passes first, it logs the
 * step that is still running, releases, and calls `exit` with the same code.
 */
export async function runShutdown(options: ShutdownOptions): Promise<number> {
  const { code, log, timers } = options;
  let pending = options.steps[0]?.name ?? "release";
  let expired = false;
  let deadlineHandle: unknown;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineHandle = timers.setTimer(() => {
      expired = true;
      resolve("deadline");
    }, options.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
  });

  const sequence = (async (): Promise<"done"> => {
    for (const step of options.steps) {
      pending = step.name;
      try {
        await step.run();
        if (!expired) log.info(step.done);
      } catch (error) {
        log.error("shutdown error", { step: step.name, error });
      }
    }
    pending = "release";
    return "done";
  })();

  const first = await Promise.race([sequence, deadline]);
  const release = async (): Promise<void> => {
    try {
      await options.release();
    } catch (error) {
      log.error("shutdown error", { step: "release", error });
    }
  };
  if (first === "deadline") {
    log.error("shutdown deadline passed", { step: pending, code });
    await release();
    options.exit(code);
    return code;
  }
  timers.clearTimer(deadlineHandle);
  await release();
  log.info("pi-sec stopped", { code });
  // Whatever a dependency forgot to unref would keep the loop alive for good.
  timers.setTimer(() => options.exit(code), options.exitFallbackMs ?? EXIT_FALLBACK_MS);
  return code;
}
