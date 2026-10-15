/**
 * D249 / D252 / D271 / D272 — compact JSON without pinning the event loop.
 *
 * Production after D247 still called `JSON.stringify(this.state)` on the
 * main thread after every stage. A large `/data/state.json` blocked the
 * loop for ~100s per checkpoint (and once for 12+ minutes). The freeze
 * watchdog then exited before `writeFile`/`rename`, so stamps never
 * landed.
 *
 * D271 wrote the dump as it walked, but `stringifyYielding` still joined
 * walked parts and yielded via `setImmediate` every 8 nodes. Production
 * 2026-10-15 2:00:55pm CT attributed 18.7s and 10.9s to
 * `json.stringify:yielding` (health overlapping campaign-audit). A
 * `setImmediate` chain starves `setInterval` (the freeze watchdog), so
 * that walk was not actually yielding. D272 yields on a time budget via
 * `setTimeout(0)`, emits flushed slices, and never concatenates the blob
 * with `+=` across the graph.
 */

import { createWriteStream } from "node:fs";
import { once } from "node:events";

export const STRINGIFY_YIELD_EVERY = 8;
/** D252 — joining already-walked parts can be a 100s slice on a large state. */
export const STRINGIFY_JOIN_CHUNK = 32;
/** D271 — flush the writer before a pending concat grows into a stall. */
export const STRINGIFY_FLUSH_BYTES = 64_000;
/** D272 — yield before a slice can trip the 1s watchdog log / 3s repeat. */
export const STRINGIFY_SLICE_MS = 8;

let lastTimerYieldAt = 0;

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    // D272 — an unbounded `setImmediate` chain starves the freeze
    // watchdog's `setInterval` (prod `json.stringify:yielding` 10–18s).
    // Return to the timer phase at least every STRINGIFY_SLICE_MS.
    // In between, `setImmediate` stays cheap so a 416×1338 min40 fill
    // is not 4ms × thousands of yields.
    const now = Date.now();
    if (now - lastTimerYieldAt >= STRINGIFY_SLICE_MS) {
      lastTimerYieldAt = now;
      setTimeout(resolve, 0);
    } else {
      setImmediate(resolve);
    }
  });
}

export function createTimeSlicer(
  sliceMs = STRINGIFY_SLICE_MS,
): () => Promise<void> {
  let mark = Date.now();
  return async () => {
    if (Date.now() - mark >= sliceMs) {
      await yieldEventLoop();
      mark = Date.now();
    }
  };
}

/**
 * D252 / D272 — assemble already-flushed slices. Never `out +=` across
 * the whole dump (immutable strings copy on each concat).
 */
async function joinYielding(
  parts: string[],
  open: string,
  close: string,
  sep: string,
): Promise<string> {
  if (parts.length === 0) return open + close;
  const pieces: string[] = [open];
  for (let i = 0; i < parts.length; i += STRINGIFY_JOIN_CHUNK) {
    pieces.push(
      (i === 0 ? "" : sep) + parts.slice(i, i + STRINGIFY_JOIN_CHUNK).join(sep),
    );
    await yieldEventLoop();
  }
  pieces.push(close);
  return pieces.join("");
}

type JsonWalkOpts = {
  yieldEvery: number;
  sliceMs: number;
};

function makeTick(opts: JsonWalkOpts): () => Promise<void> {
  const slice = createTimeSlicer(opts.sliceMs);
  let ops = 0;
  return async () => {
    ops += 1;
    if (ops % opts.yieldEvery === 0) await yieldEventLoop();
    else await slice();
  };
}

async function walkJson(
  node: unknown,
  emit: (chunk: string) => Promise<void>,
  tick: () => Promise<void>,
): Promise<void> {
  if (node === null || typeof node !== "object") {
    await emit(JSON.stringify(node));
    return;
  }
  const withToJson = node as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    await walkJson(withToJson.toJSON(), emit, tick);
    return;
  }
  if (Array.isArray(node)) {
    await emit("[");
    for (let i = 0; i < node.length; i += 1) {
      if (i > 0) await emit(",");
      const item = node[i];
      if (item === undefined) await emit("null");
      else await walkJson(item, emit, tick);
      await tick();
    }
    await emit("]");
    return;
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  await tick();
  await emit("{");
  let first = true;
  for (const key of keys) {
    const child = record[key];
    if (child === undefined) continue;
    if (!first) await emit(",");
    first = false;
    await emit(`${JSON.stringify(key)}:`);
    await walkJson(child, emit, tick);
    await tick();
  }
  await emit("}");
}

export async function stringifyYielding(
  value: unknown,
  opts: { yieldEvery?: number; flushBytes?: number; sliceMs?: number } = {},
): Promise<string> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? STRINGIFY_YIELD_EVERY);
  const flushBytes = Math.max(1024, opts.flushBytes ?? STRINGIFY_FLUSH_BYTES);
  const tick = makeTick({
    yieldEvery,
    sliceMs: Math.max(1, opts.sliceMs ?? STRINGIFY_SLICE_MS),
  });
  const chunks: string[] = [];
  let pending = "";
  await yieldEventLoop();

  const emit = async (chunk: string): Promise<void> => {
    pending += chunk;
    while (pending.length >= flushBytes) {
      chunks.push(pending.slice(0, flushBytes));
      pending = pending.slice(flushBytes);
      await tick();
    }
  };

  await walkJson(value, emit, tick);
  if (pending) chunks.push(pending);
  return joinYielding(chunks, "", "", "");
}

/**
 * D271 / D272 — walk the graph and write compact JSON to `filePath` in
 * flushed, time-sliced writes. Never concatenate the full dump into one
 * string on this thread.
 */
export async function stringifyYieldingToFile(
  value: unknown,
  filePath: string,
  opts: { yieldEvery?: number; flushBytes?: number; sliceMs?: number } = {},
): Promise<number> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? STRINGIFY_YIELD_EVERY);
  const flushBytes = Math.max(1024, opts.flushBytes ?? STRINGIFY_FLUSH_BYTES);
  const tick = makeTick({
    yieldEvery,
    sliceMs: Math.max(1, opts.sliceMs ?? STRINGIFY_SLICE_MS),
  });
  const file = createWriteStream(filePath);
  let written = 0;
  let pending = "";
  await yieldEventLoop();

  const flush = async (force = false): Promise<void> => {
    while (pending.length >= flushBytes || (force && pending.length > 0)) {
      const slice = force && pending.length < flushBytes
        ? pending
        : pending.slice(0, flushBytes);
      pending = force && slice === pending ? "" : pending.slice(slice.length);
      written += Buffer.byteLength(slice);
      if (!file.write(slice)) await once(file, "drain");
      await tick();
    }
  };

  const emit = async (chunk: string): Promise<void> => {
    pending += chunk;
    if (pending.length >= flushBytes) await flush();
  };

  try {
    await walkJson(value, emit, tick);
    await flush(true);
    file.end();
    await once(file, "finish");
    return written;
  } catch (error) {
    file.destroy();
    throw error;
  }
}
