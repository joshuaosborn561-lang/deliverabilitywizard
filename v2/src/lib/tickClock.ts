import { V2_FETCH_TIMEOUT_MS } from "../canon/constants.js";

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

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new TickTimeoutError("sleep", 0));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new TickTimeoutError("sleep", 0));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
      return Math.max(0, timeoutMs - (Date.now() - started));
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
