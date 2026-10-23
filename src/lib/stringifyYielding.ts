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
 *
 * D299 — a time slice still ran `JSON.stringify` / `Object.keys` on one
 * whole value. Production 2026-10-23 pinned the loop for 5–51s inside
 * campaign-health (`json.stringify:hot` / `json.stringify:state`) and the
 * freeze watchdog exited. Compact subtrees are native-stringified in
 * small batches; a long string is escaped in slices. Output stays
 * byte-identical to `JSON.stringify`.
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
/** D299 — native-stringify this many compact values, then yield. */
export const STRINGIFY_BATCH_ITEMS = 24;
/** D299 — a longer string is escaped in slices instead of one JSON.stringify. */
export const STRINGIFY_COMPACT_STRING_CHARS = 4_096;
const STRINGIFY_STRING_SLICE_CHARS = 8_192;
const COMPACT_FANOUT = 24;
const COMPACT_DEPTH = 4;

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
 * D289 — yield on a time budget every item. Count-based `every N`
 * alone is not enough: 8 expensive accounts can still pin the loop
 * past the freeze watchdog's 3s repeat. Call once per item.
 */
export function createLoopYielder(
  every = STRINGIFY_YIELD_EVERY,
  sliceMs = STRINGIFY_SLICE_MS,
): () => Promise<void> {
  const slice = createTimeSlicer(sliceMs);
  const cadence = Math.max(1, every);
  let n = 0;
  return async () => {
    n += 1;
    if (n % cadence === 0) await yieldEventLoop();
    else await slice();
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

function omittedJsonValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

/**
 * D299 — true when `JSON.stringify(value)` is a small native call.
 * Stops after a handful of keys so a map of hundreds of thousands of
 * mailboxes is not `Object.keys`'d just to discover it is fat.
 */
export function isCompactJsonValue(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.length <= STRINGIFY_COMPACT_STRING_CHARS;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  if (depth >= COMPACT_DEPTH) return false;
  const withToJson = value as { toJSON?: () => unknown };
  if (!Array.isArray(value) && typeof withToJson.toJSON === "function") {
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > COMPACT_FANOUT) return false;
    for (let i = 0; i < value.length; i += 1) {
      const item = Object.hasOwn(value, i) ? value[i] : null;
      if (!isCompactJsonValue(omittedJsonValue(item) ? null : item, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  const record = value as Record<string, unknown>;
  let seen = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    seen += 1;
    if (seen > COMPACT_FANOUT) return false;
    const child = record[key];
    if (omittedJsonValue(child)) continue;
    if (!isCompactJsonValue(child, depth + 1)) return false;
  }
  return true;
}

async function emitJsonString(
  value: string,
  emit: (chunk: string) => Promise<void>,
  tick: () => Promise<void>,
): Promise<void> {
  await emit('"');
  for (let i = 0; i < value.length; ) {
    let end = Math.min(value.length, i + STRINGIFY_STRING_SLICE_CHARS);
    // Keep a surrogate pair in one slice so the encoding matches
    // JSON.stringify of the whole string.
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) {
      end += 1;
    }
    const encoded = JSON.stringify(value.slice(i, end));
    await emit(encoded.slice(1, -1));
    await tick();
    i = end;
  }
  await emit('"');
}

async function walkJson(
  node: unknown,
  emit: (chunk: string) => Promise<void>,
  tick: () => Promise<void>,
): Promise<void> {
  if (node === null || typeof node !== "object") {
    if (typeof node === "string" && node.length > STRINGIFY_COMPACT_STRING_CHARS) {
      await emitJsonString(node, emit, tick);
      return;
    }
    const encoded = JSON.stringify(node);
    await emit(encoded === undefined ? "null" : encoded);
    return;
  }
  const withToJson = node as { toJSON?: () => unknown };
  if (!Array.isArray(node) && typeof withToJson.toJSON === "function") {
    const rendered = withToJson.toJSON();
    if (rendered === undefined) {
      await emit("null");
      return;
    }
    await walkJson(rendered, emit, tick);
    return;
  }
  if (Array.isArray(node)) {
    await emit("[");
    let first = true;
    let batch: unknown[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const inner = JSON.stringify(batch).slice(1, -1);
      if (!first) await emit(",");
      first = false;
      if (inner) await emit(inner);
      batch = [];
      await tick();
    };
    for (let i = 0; i < node.length; i += 1) {
      const raw = Object.hasOwn(node, i) ? node[i] : null;
      const item = omittedJsonValue(raw) ? null : raw;
      if (isCompactJsonValue(item)) {
        batch.push(item);
        if (batch.length >= STRINGIFY_BATCH_ITEMS) await flush();
        continue;
      }
      await flush();
      if (!first) await emit(",");
      first = false;
      await walkJson(item, emit, tick);
      await tick();
    }
    await flush();
    await emit("]");
    return;
  }
  const record = node as Record<string, unknown>;
  await emit("{");
  let first = true;
  let batch: Record<string, unknown> = Object.create(null);
  let batchCount = 0;
  const flush = async (): Promise<void> => {
    if (!batchCount) return;
    const inner = JSON.stringify(batch).slice(1, -1);
    if (inner) {
      if (!first) await emit(",");
      first = false;
      await emit(inner);
    }
    batch = Object.create(null);
    batchCount = 0;
    await tick();
  };
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const child = record[key];
    if (omittedJsonValue(child)) continue;
    // JSON.stringify omits an object key whose toJSON() returns undefined.
    // Call it once here so the key is dropped instead of encoded as null.
    let payload: unknown = child;
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      typeof (child as { toJSON?: unknown }).toJSON === "function"
    ) {
      payload = (child as { toJSON: () => unknown }).toJSON();
      if (payload === undefined) continue;
    }
    if (isCompactJsonValue(payload)) {
      batch[key] = payload;
      batchCount += 1;
      if (batchCount >= STRINGIFY_BATCH_ITEMS) await flush();
      continue;
    }
    await flush();
    if (!first) await emit(",");
    first = false;
    await emit(`${JSON.stringify(key)}:`);
    await walkJson(payload, emit, tick);
    await tick();
  }
  await flush();
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
