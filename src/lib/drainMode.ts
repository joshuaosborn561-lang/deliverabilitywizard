/**
 * D308 (A0) — drain mode: stop starting new passes, let the in-flight
 * work finish, and say when a deploy is safe.
 *
 * Why: Railway auto-deploys every merge to main and a deploy restarts the
 * process, killing any running pass. The health pass runs for 20–135
 * minutes against a 15 minute cadence, so "deploy when nothing is
 * running" had no usable window. Drain mode skips every NEW cron tick
 * (and the post-pass retry kicks) while whatever is already running
 * finishes; `/health` then reports `safeToDeploy` once nothing is left.
 *
 * Drain never changes campaigns, mailboxes, settings or WRITE_ENABLED. It
 * only decides whether a scheduled job may start. It is in-memory on
 * purpose: a deploy restarts the process, which ends the drain.
 * It auto-expires so a forgotten drain cannot silence the machine.
 */

export const DRAIN_DEFAULT_MS = 30 * 60 * 1000;
export const DRAIN_MAX_MS = 120 * 60 * 1000;

export interface DrainSnapshot {
  draining: boolean;
  since: string | null;
  expiresAt: string | null;
  reason: string | null;
  /** Ticks skipped during this drain, by job name. */
  skipped: Record<string, number>;
}

export class DrainMode {
  private sinceMs: number | null = null;
  private expiresAtMs: number | null = null;
  private reasonText: string | null = null;
  private skipped = new Map<string, number>();

  /** Start (or extend) a drain. `maxMs` is clamped to DRAIN_MAX_MS. */
  start(opts: { now?: number; maxMs?: number; reason?: string } = {}): DrainSnapshot {
    const now = opts.now ?? Date.now();
    const requested = Number.isFinite(opts.maxMs) && (opts.maxMs as number) > 0
      ? (opts.maxMs as number)
      : DRAIN_DEFAULT_MS;
    const ttl = Math.min(requested, DRAIN_MAX_MS);
    if (this.sinceMs === null || this.expiredAt(now)) {
      this.sinceMs = now;
      this.skipped = new Map();
    }
    this.expiresAtMs = now + ttl;
    this.reasonText = opts.reason?.slice(0, 200) || this.reasonText || "deploy";
    return this.snapshot(now);
  }

  stop(now = Date.now()): DrainSnapshot {
    this.sinceMs = null;
    this.expiresAtMs = null;
    this.reasonText = null;
    return this.snapshot(now);
  }

  private expiredAt(now: number): boolean {
    return this.expiresAtMs !== null && now >= this.expiresAtMs;
  }

  isDraining(now = Date.now()): boolean {
    if (this.sinceMs === null) return false;
    if (this.expiredAt(now)) {
      this.stop(now);
      return false;
    }
    return true;
  }

  /** True (and counted) when a job named `name` must not start now. */
  shouldSkip(name: string, now = Date.now()): boolean {
    if (!this.isDraining(now)) return false;
    this.skipped.set(name, (this.skipped.get(name) ?? 0) + 1);
    return true;
  }

  snapshot(now = Date.now()): DrainSnapshot {
    const draining = this.isDraining(now);
    return {
      draining,
      since: draining && this.sinceMs !== null ? new Date(this.sinceMs).toISOString() : null,
      expiresAt:
        draining && this.expiresAtMs !== null ? new Date(this.expiresAtMs).toISOString() : null,
      reason: draining ? this.reasonText : null,
      skipped: draining ? Object.fromEntries(this.skipped) : {},
    };
  }
}

/** Names of cron-started jobs that are running right now. */
export class ActiveJobs {
  private counts = new Map<string, number>();

  /** Track a promise without changing its outcome or creating a new rejection. */
  track(name: string, work: PromiseLike<unknown>): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    const done = (): void => {
      const left = (this.counts.get(name) ?? 1) - 1;
      if (left <= 0) this.counts.delete(name);
      else this.counts.set(name, left);
    };
    void work.then(done, done);
  }

  names(): string[] {
    return [...this.counts.keys()].sort();
  }
}

export interface DeploySafety {
  /** Nothing is running at this instant. A new tick may start any second unless draining. */
  idleNow: boolean;
  /** Draining AND nothing running: nothing new will start, so a deploy kills no job. */
  safeToDeploy: boolean;
  activeJobs: string[];
}

export function deploySafety(input: {
  draining: boolean;
  activeJobs: string[];
}): DeploySafety {
  const activeJobs = [...new Set(input.activeJobs)].sort();
  const idleNow = activeJobs.length === 0;
  return { idleNow, safeToDeploy: idleNow && input.draining, activeJobs };
}

/** `?minutes=` / body value in minutes -> ms (undefined = default). */
export function parseDrainMinutes(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.min(minutes * 60 * 1000, DRAIN_MAX_MS);
}
