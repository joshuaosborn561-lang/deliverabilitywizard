/**
 * D271 — name the event-loop stall. The freeze watchdog used to log
 * only a delay in milliseconds, so every restart was a guess. Stamp the
 * in-flight stage, the current named op (JSON / fs / scan), the last
 * async_hooks resource, a sampled stack, and perf_hooks delay/ELU.
 *
 * AsyncLocalStorage is not visible from the watchdog timer (different
 * async context). `before()` snapshots the op/stack from the callback
 * that is about to run — after a sync stall that snapshot is the culprit.
 */

import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export const STALL_NAMED_OP_LOG_MS = 1_000;
export const STALL_STACK_SAMPLE_MS = 20;
export const STALL_STACK_LINES = 8;

export interface StallLockStage {
  name: string;
  stage?: string | null;
  since: number | null;
}

export interface StallScope {
  op: string;
}

const als = new AsyncLocalStorage<StallScope>();

let lastOp: string | null = null;
let lastAsyncType: string | null = null;
let lastStack: string | null = null;
let lastStackAt = 0;
let hookStarted = false;
let hook: ReturnType<typeof createHook> | null = null;
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lastElu = performance.eventLoopUtilization();
const watchdogAsyncIds = new Set<number>();
let cbOp: string | null = null;
let cbStartedAt: number | null = null;
let worstCbMs = 0;
let worstCbOp: string | null = null;
let worstCbType: string | null = null;
const asyncTypes = new Map<number, string>();

function captureStack(): string {
  const stack = new Error("stall-sample").stack ?? "";
  return stack
    .split("\n")
    .slice(2, 2 + STALL_STACK_LINES + 6)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("at ") &&
        !/eventLoopAttribution|freezeWatchdog|node:internal|async_hooks/.test(
          line,
        ),
    )
    .slice(0, STALL_STACK_LINES)
    .join(" | ");
}

export function currentStallOp(): string | null {
  return als.getStore()?.op ?? lastOp;
}

export function markWatchdogAsyncId(asyncId: number): void {
  watchdogAsyncIds.add(asyncId);
}

export function startEventLoopAttribution(): { stop: () => void } {
  if (hookStarted) {
    return {
      stop: () => {
        hook?.disable();
        histogram?.disable();
        hookStarted = false;
        hook = null;
        histogram = null;
      },
    };
  }
  hookStarted = true;
  hook = createHook({
    init(asyncId, type) {
      asyncTypes.set(asyncId, type);
    },
    before(asyncId) {
      if (watchdogAsyncIds.has(asyncId)) return;
      lastAsyncType = asyncTypes.get(asyncId) ?? null;
      const op = als.getStore()?.op;
      if (op) lastOp = op;
      cbOp = op ?? null;
      cbStartedAt = performance.now();
      const now = Date.now();
      if (now - lastStackAt >= STALL_STACK_SAMPLE_MS) {
        lastStack = captureStack();
        lastStackAt = now;
      }
    },
    after(asyncId) {
      if (watchdogAsyncIds.has(asyncId) || cbStartedAt == null) return;
      // D302 — name the callback that actually held the loop. Sticky
      // lastOp alone blamed unscoped sync stalls on the last named op
      // (json.stringify:hot / scan:campaignHealthSnapshots), so D299/D300
      // tuned the wrong code while per-mailbox canary lookups pinned it.
      const ms = performance.now() - cbStartedAt;
      if (ms > worstCbMs) {
        worstCbMs = ms;
        worstCbOp = cbOp ?? "unscoped";
        worstCbType = lastAsyncType;
      }
      cbStartedAt = null;
    },
    destroy(asyncId) {
      asyncTypes.delete(asyncId);
      watchdogAsyncIds.delete(asyncId);
    },
  });
  hook.enable();
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  lastElu = performance.eventLoopUtilization();
  return {
    stop: () => {
      hook?.disable();
      histogram?.disable();
      hookStarted = false;
      hook = null;
      histogram = null;
    },
  };
}

export function runWithStallScope<T>(op: string, fn: () => T): T {
  return als.run({ op }, () => {
    lastOp = op;
    return fn();
  });
}

export async function runWithStallScopeAsync<T>(
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run({ op }, async () => {
    lastOp = op;
    const started = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - started;
      if (ms >= STALL_NAMED_OP_LOG_MS) {
        console.warn(
          `[watchdog] named-op ${op} wall ${Math.round(ms)}ms stage=${formatLockStages(lastLockSnapshot)}`,
        );
      }
    }
  });
}

let lastLockSnapshot: StallLockStage[] = [];

export function rememberLockStages(locks: StallLockStage[]): void {
  lastLockSnapshot = locks;
}

export function formatLockStages(locks: StallLockStage[]): string {
  const live = locks.filter((lock) => lock.since != null);
  if (!live.length) return "none";
  return live
    .map((lock) => `${lock.name}:${lock.stage || "unknown"}`)
    .join(",");
}

export function formatStallAttribution(locks: StallLockStage[]): string {
  rememberLockStages(locks);
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const delayMaxMs =
    histogram != null ? Math.round(histogram.max / 1e6) : null;
  histogram?.reset();
  const op = als.getStore()?.op ?? lastOp ?? "unknown";
  const stack = lastStack ? lastStack.slice(0, 400) : "none";
  const eluBit = Number.isFinite(elu.utilization)
    ? elu.utilization.toFixed(2)
    : "n/a";
  const delayBit = delayMaxMs == null ? "n/a" : String(delayMaxMs);
  const worst =
    worstCbOp != null
      ? ` longest=${worstCbOp}:${Math.round(worstCbMs)}ms(${worstCbType ?? "none"})`
      : "";
  worstCbMs = 0;
  worstCbOp = null;
  worstCbType = null;
  return `stage=${formatLockStages(locks)} op=${op} async=${lastAsyncType ?? "none"} elu=${eluBit} delay.max=${delayBit}ms${worst} stack=${stack}`;
}

export function freezeDelayLogLine(
  delayMs: number,
  locks: StallLockStage[],
): string {
  return `[watchdog] event-loop delay ${delayMs}ms ${formatStallAttribution(locks)}`;
}

/** Test helper — seed the last-before snapshot without starting the hook. */
export function seedStallSnapshot(input: {
  op?: string | null;
  asyncType?: string | null;
  stack?: string | null;
}): void {
  if (input.op !== undefined) lastOp = input.op;
  if (input.asyncType !== undefined) lastAsyncType = input.asyncType;
  if (input.stack !== undefined) lastStack = input.stack;
}
