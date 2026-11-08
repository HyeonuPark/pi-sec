/**
 * Whether a cold restart is needed, and whether it is ready to be applied.
 *
 * These are two facts, not one, and the operator needs both. `required` is the
 * truth: committed core work is not what the running process booted from.
 * `ready` is the signal: the batch is closed and its gate passed, so running
 * `user-tools/update-and-restart` right now applies a complete change.
 *
 * They used to be a single boolean that only ever went up. A restart applies
 * whatever is on disk at that moment, so an invitation raised by the first edit
 * of a batch could be taken up while the rest of it was still being written —
 * booting half a change. Recording another core edit now takes `ready` back
 * down, which is the whole reason the two fields exist.
 *
 * `required` cannot be withdrawn. A committed core change needs a restart
 * whether or not anyone is asking for one, so hiding it would only lose the
 * fact. `withdraw()` retracts the request, never the need.
 */
export interface RestartStatus {
  readonly required: boolean;
  readonly ready: boolean;
  /** When the need first appeared in this process. */
  readonly requiredAt?: number;
  /** When the batch was last declared complete and its gate passed. */
  readonly readyAt?: number;
}

export class RestartState {
  #required = false;
  #ready = false;
  #requiredAt: number | undefined;
  #readyAt: number | undefined;

  /** A core change was recorded: a restart is needed, and any earlier "go ahead" is stale. */
  requireRestart(at: number = Date.now()): void {
    if (!this.#required) {
      this.#required = true;
      this.#requiredAt = at;
    }
    this.withdraw();
  }

  /**
   * The batch is closed and its gate passed: the operator may restart now.
   *
   * Does nothing when no restart is required — a "go ahead" with nothing to
   * apply is not a state worth inventing.
   */
  markReady(at: number = Date.now()): void {
    if (!this.#required) return;
    this.#ready = true;
    this.#readyAt = at;
  }

  /** Retract the request. The need stays, so the banner reports "waiting" rather than vanishing. */
  withdraw(): void {
    this.#ready = false;
    this.#readyAt = undefined;
  }

  get status(): RestartStatus {
    return {
      required: this.#required,
      ready: this.#ready,
      ...(this.#requiredAt === undefined ? {} : { requiredAt: this.#requiredAt }),
      ...(this.#readyAt === undefined ? {} : { readyAt: this.#readyAt }),
    };
  }
}
