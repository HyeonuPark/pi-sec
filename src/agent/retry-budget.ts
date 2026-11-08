/**
 * A process-wide sliding window over failed model attempts.
 *
 * Why this lives outside the harness: the retry decision is the durable
 * library's, and it reads its policy from `HarnessSettings.retry` at every
 * attempt. `src/agent/settings.ts` hands that getter this object, so a spent
 * budget makes the library decide "no further retry" without this code touching
 * the library or the run. The one place that can change the decision is the
 * policy the library reads, so the budget is enforced by changing that policy
 * and by nothing else.
 *
 * The window is memory-only, and that is the intended failure mode. A restart
 * forgets the count and retries are allowed again: the budget exists to stop an
 * outage from spreading inside one process lifetime, not to keep a score across
 * restarts. Session documents are deliberately left alone so a rollback stays
 * simple.
 */
export class RetryBudget {
  /** Timestamps of failed attempts, oldest first. */
  readonly #failures: number[] = [];
  /** Conversations already told that the budget is spent, in this window. */
  readonly #told = new Set<string>();

  /**
   * Keep one window's worth of history and no more.
   *
   * The window is read from the config at each question, so it can move; the
   * cap is what keeps a long window from growing this array without bound.
   */
  static readonly #KEEP = 4096;

  /** Record one failed model attempt. */
  record(at: number): void {
    this.#failures.push(at);
    if (this.#failures.length > RetryBudget.#KEEP) this.#failures.splice(0, this.#failures.length - RetryBudget.#KEEP);
  }

  /** Failed attempts inside `windowMs` of `now`. Older ones are dropped. */
  count(now: number, windowMs: number): number {
    const from = now - Math.max(0, windowMs);
    while (this.#failures.length > 0 && this.#failures[0]! < from) this.#failures.shift();
    return this.#failures.length;
  }

  /**
   * Whether the budget is spent.
   *
   * A maximum of zero or less means "no budget": the operator switches retries
   * off with `agent.retry.enabled`, not by setting a count that would stop every
   * retry after the first failure.
   */
  spent(now: number, windowMs: number, maxFailures: number): boolean {
    if (maxFailures <= 0) return false;
    return this.count(now, windowMs) >= maxFailures;
  }

  /**
   * Name one conversation once, while the budget is spent.
   *
   * A failure repeats every few seconds and each one would be told again; the
   * parent needs the fact once, not once per attempt.
   */
  claimNotice(conversationId: string): boolean {
    if (this.#told.has(conversationId)) return false;
    this.#told.add(conversationId);
    return true;
  }

  /** Forget who was told, so a later spend is announced again. */
  forgetNotices(): void {
    this.#told.clear();
  }
}
