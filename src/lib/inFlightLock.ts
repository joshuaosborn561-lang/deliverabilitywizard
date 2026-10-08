/**
 * D247 — process-wide pass locks that expire so a hung health / canon-ops
 * / monitor sitting cannot block every later cron. Takeover issues a new
 * ownership token; the old pass's `finally` cleanup must not release the
 * new owner's lock.
 */

export const HEALTH_LOCK_MAX_MS = 45 * 60 * 1000;
export const CANON_OPS_LOCK_MAX_MS = 30 * 60 * 1000;
export const MONITOR_LOCK_MAX_MS = 3 * 60 * 60 * 1000;

export interface InFlightSnapshot {
  since: string;
  stage: string;
}

export interface LockAcquire {
  ok: true;
  token: string;
  takeover: boolean;
}

export class InFlightLock {
  private token: string | null = null;
  private sinceMs: number | null = null;
  private stageName: string | null = null;

  constructor(
    readonly name: string,
    readonly maxMs: number,
  ) {}

  get held(): boolean {
    return this.token !== null;
  }

  /** Held and still inside the max — later crons should skip. */
  isLive(now = Date.now()): boolean {
    return this.held && !this.isStale(now);
  }

  isStale(now = Date.now()): boolean {
    return this.held && this.sinceMs !== null && now - this.sinceMs > this.maxMs;
  }

  /** Past twice the max — freeze watchdog exits so Railway restarts. */
  isStuckPastDouble(now = Date.now()): boolean {
    return this.held && this.sinceMs !== null && now - this.sinceMs > this.maxMs * 2;
  }

  get since(): number | null {
    return this.sinceMs;
  }

  ageMs(now = Date.now()): number | null {
    return this.sinceMs === null ? null : now - this.sinceMs;
  }

  snapshot(): InFlightSnapshot | null {
    if (!this.held || this.sinceMs === null) return null;
    return {
      since: new Date(this.sinceMs).toISOString(),
      stage: this.stageName ?? "unknown",
    };
  }

  /**
   * Take the lock. Returns null when a live owner still holds it.
   * A stale lock is taken over with a new token.
   */
  acquire(stage: string, now = Date.now()): LockAcquire | null {
    if (this.held && !this.isStale(now)) return null;
    const takeover = this.held && this.isStale(now);
    const token = `${this.name}-${now}-${Math.random().toString(36).slice(2, 10)}`;
    this.token = token;
    this.sinceMs = now;
    this.stageName = stage;
    return { ok: true, token, takeover };
  }

  owns(token: string): boolean {
    return this.token === token;
  }

  setStage(token: string, stage: string): void {
    if (this.token === token) this.stageName = stage;
  }

  /** Clears only when `token` is still the owner. */
  release(token: string): boolean {
    if (this.token !== token) return false;
    this.token = null;
    this.sinceMs = null;
    this.stageName = null;
    return true;
  }
}
