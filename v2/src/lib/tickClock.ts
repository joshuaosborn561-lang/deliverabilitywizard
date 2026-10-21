import { V2_FETCH_TIMEOUT_MS, V2_SMARTLEAD_429_MAX_WAIT_MS, V2_TICK_ABORT_GRACE_MS } from "../canon/constants.js";

const tickDeadlines = new WeakMap<AbortSignal, number>();

export class TickTimeoutError extends Error {
  readonly reason = "timeout" as const;
  constructor(
    public readonly hungIn: string,
    public readonly elapsedMs: number,
  ) {
    super(`tick timeout hung_in=${hungIn} elapsed_ms=${elapsedMs}`);
    this.name = "TickTimeoutError";
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError" || error instanceof TickTimeoutError;
}

export function isTickTimeoutError(error: unknown): error is TickTimeoutError {
  return error instanceof TickTimeoutError;
}

export function throwIfAborted(signal?: AbortSignal, hungIn = "unknown"): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof TickTimeoutError) throw reason;
  throw new TickTimeoutError(hungIn, 0);
}

export function remainingFromSignal(signal?: AbortSignal, now = Date.now()): number | undefined {
  if (!signal) return undefined;
  const deadline = tickDeadlines.get(signal);
  if (deadline == null) return undefined;
  return Math.max(0, deadline - now);
}

/** Honor Retry-After, but never past the tick deadline (or a 30s backstop with no tick). */
export function capWaitMs(requestedMs: number, signal?: AbortSignal): number {
  const remaining = remainingFromSignal(signal);
  const cap = remaining == null ? V2_SMARTLEAD_429_MAX_WAIT_MS : remaining;
  return Math.max(0, Math.min(Math.max(0, requestedMs), cap));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const wait = capWaitMs(ms, signal);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new TickTimeoutError("sleep", 0));
      return;
    }
    if (wait <= 0) {
      if (signal && remainingFromSignal(signal) === 0) {
        reject(new TickTimeoutError("sleep", 0));
        return;
      }
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new TickTimeoutError("sleep", 0));
        return;
      }
      if (signal && remainingFromSignal(signal) === 0) {
        reject(new TickTimeoutError("sleep", 0));
        return;
      }
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new TickTimeoutError("sleep", 0));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * D284 — a hung await that ignores AbortSignal still loses. Used around
 * fetch, limiter retries, and the whole tick so the lease is released.
 */
export function raceDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  hungIn: string,
  timeoutMs?: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      fn();
    };
    const fail = (error: unknown) =>
      finish(() => {
        reject(error instanceof Error ? error : new TickTimeoutError(hungIn, 0));
      });
    const onAbort = () =>
      fail(signal?.reason instanceof Error ? signal.reason : new TickTimeoutError(hungIn, 0));
    if (signal?.aborted) {
      onAbort();
      void promise.catch(() => undefined);
      return;
    }
    const timer =
      timeoutMs != null && timeoutMs >= 0
        ? setTimeout(() => fail(new TickTimeoutError(hungIn, timeoutMs)), timeoutMs)
        : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => fail(error),
    );
  });
}

/** After the tick abort fires, give in-memory scoring a beat to finish. */
export function withTickDeadline<T>(tick: TickHandle, work: Promise<T>, graceMs = V2_TICK_ABORT_GRACE_MS): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const fire = () => {
      setTimeout(() => {
        reject(
          tick.signal.reason instanceof TickTimeoutError
            ? tick.signal.reason
            : new TickTimeoutError(tick.hungIn, tick.elapsedMs()),
        );
      }, graceMs);
    };
    if (tick.signal.aborted) fire();
    else tick.signal.addEventListener("abort", fire, { once: true });
  });
  return Promise.race([work, timeout]);
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return AbortSignal.timeout(V2_FETCH_TIMEOUT_MS);
  if (live.length === 1) return live[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const ac = new AbortController();
  const forward = () => ac.abort();
  for (const signal of live) {
    if (signal.aborted) {
      ac.abort(signal.reason);
      return ac.signal;
    }
    signal.addEventListener("abort", forward, { once: true });
  }
  return ac.signal;
}

export interface TickHandle {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  step(name: string): void;
  get hungIn(): string;
  elapsedMs(): number;
  remainingMs(): number;
  throwIfAborted(): void;
  dispose(): void;
}

export function startTick(timeoutMs: number): TickHandle {
  const ac = new AbortController();
  const started = Date.now();
  const deadlineAt = started + timeoutMs;
  tickDeadlines.set(ac.signal, deadlineAt);
  let hungIn = "start";
  const timer = setTimeout(() => {
    if (!ac.signal.aborted) {
      ac.abort(new TickTimeoutError(hungIn, Date.now() - started));
    }
  }, timeoutMs);
  return {
    signal: ac.signal,
    timeoutMs,
    step(name: string) {
      hungIn = name;
      throwIfAborted(ac.signal, hungIn);
    },
    get hungIn() {
      return hungIn;
    },
    elapsedMs() {
      return Date.now() - started;
    },
    remainingMs() {
      return Math.max(0, deadlineAt - Date.now());
    },
    throwIfAborted() {
      throwIfAborted(ac.signal, hungIn);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

export function leaseIsStale(
  inFlightSince: string | Date | null | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean {
  if (!inFlightSince) return true;
  const at =
    inFlightSince instanceof Date ? inFlightSince.getTime() : Date.parse(String(inFlightSince));
  if (!Number.isFinite(at)) return true;
  return now - at >= ttlMs;
}

/**
 * Child signal that aborts at `budgetMs` from now or when `parent` aborts.
 * Used to cap SmartDelivery hydration so scoring keeps part of the tick.
 */
export function budgetSignal(parent: AbortSignal | undefined, budgetMs: number): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(Object.assign(new Error(`stage budget ${budgetMs}ms`), { name: "AbortError" }));
  }, Math.max(0, budgetMs));
  return { signal: combineSignals(parent, ac.signal), dispose: () => clearTimeout(timer) };
}

/** Fractions of the isolation tick spent listing / hydrating before scoring must start. */
export const ISOLATION_BUDGET = { listTests: 0.25, hydrateSenders: 0.4, hydrateProviders: 0.55 } as const;
