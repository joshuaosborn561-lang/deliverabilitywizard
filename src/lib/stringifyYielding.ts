/**
 * D249 / D252 / D271 — compact JSON without pinning the event loop.
 *
 * Production after D247 still called `JSON.stringify(this.state)` on the
 * main thread after every stage. A large `/data/state.json` blocked the
 * loop for ~100s per checkpoint (and once for 12+ minutes). The freeze
 * watchdog then exited before `writeFile`/`rename`, so stamps never
 * landed. Walk the graph in small slices and `setImmediate` between
 * them so `/health`, cron, and the watchdog can breathe.
 *
 * D271 — the full dump writes to disk as it walks. Joining already-walked
 * parts of a ~100MB graph was still an 18–25s slice (D252 chunked the
 * join, not the write). `stringifyYieldingToFile` never holds the blob.
 */

import { createWriteStream } from "node:fs";
import { once } from "node:events";

export const STRINGIFY_YIELD_EVERY = 8;
/** D252 — joining already-walked parts can be a 100s slice on a large state. */
export const STRINGIFY_JOIN_CHUNK = 32;
/** D271 — flush the writer before a pending concat grows into a stall. */
export const STRINGIFY_FLUSH_BYTES = 64_000;

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function joinYielding(
  parts: string[],
  open: string,
  close: string,
  sep: string,
): Promise<string> {
  if (parts.length === 0) return open + close;
  let out = open;
  for (let i = 0; i < parts.length; i += STRINGIFY_JOIN_CHUNK) {
    const slice = parts.slice(i, i + STRINGIFY_JOIN_CHUNK);
    out += (i === 0 ? "" : sep) + slice.join(sep);
    await yieldEventLoop();
  }
  return out + close;
}

export async function stringifyYielding(
  value: unknown,
  opts: { yieldEvery?: number } = {},
): Promise<string> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? STRINGIFY_YIELD_EVERY);
  let ops = 0;
  await yieldEventLoop();
  const tick = async (): Promise<void> => {
    ops += 1;
    if (ops % yieldEvery === 0) await yieldEventLoop();
  };

  const walk = async (node: unknown): Promise<string> => {
    if (node === null || typeof node !== "object") {
      return JSON.stringify(node);
    }
    const withToJson = node as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") {
      return walk(withToJson.toJSON());
    }
    if (Array.isArray(node)) {
      const parts: string[] = [];
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i];
        parts.push(item === undefined ? "null" : await walk(item));
        await tick();
      }
      return joinYielding(parts, "[", "]", ",");
    }
    const record = node as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${await walk(child)}`);
      await tick();
    }
    return joinYielding(parts, "{", "}", ",");
  };

  return walk(value);
}

/**
 * D271 — walk the graph and write compact JSON to `filePath` in flushed
 * slices. Never concatenate the full dump into one string on this thread.
 */
export async function stringifyYieldingToFile(
  value: unknown,
  filePath: string,
  opts: { yieldEvery?: number; flushBytes?: number } = {},
): Promise<number> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? STRINGIFY_YIELD_EVERY);
  const flushBytes = Math.max(1024, opts.flushBytes ?? STRINGIFY_FLUSH_BYTES);
  const file = createWriteStream(filePath);
  let written = 0;
  let pending = "";
  let ops = 0;
  await yieldEventLoop();

  const flush = async (force = false): Promise<void> => {
    while (pending.length >= flushBytes || (force && pending.length > 0)) {
      const slice = force && pending.length < flushBytes
        ? pending
        : pending.slice(0, flushBytes);
      pending = force && slice === pending ? "" : pending.slice(slice.length);
      written += Buffer.byteLength(slice);
      if (!file.write(slice)) await once(file, "drain");
      await yieldEventLoop();
    }
  };

  const emit = async (chunk: string): Promise<void> => {
    pending += chunk;
    if (pending.length >= flushBytes) await flush();
  };

  const tick = async (): Promise<void> => {
    ops += 1;
    if (ops % yieldEvery === 0) await yieldEventLoop();
  };

  const walk = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object") {
      await emit(JSON.stringify(node));
      return;
    }
    const withToJson = node as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") {
      await walk(withToJson.toJSON());
      return;
    }
    if (Array.isArray(node)) {
      await emit("[");
      for (let i = 0; i < node.length; i += 1) {
        if (i > 0) await emit(",");
        const item = node[i];
        if (item === undefined) await emit("null");
        else await walk(item);
        await tick();
      }
      await emit("]");
      return;
    }
    const record = node as Record<string, unknown>;
    await emit("{");
    let first = true;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child === undefined) continue;
      if (!first) await emit(",");
      first = false;
      await emit(`${JSON.stringify(key)}:`);
      await walk(child);
      await tick();
    }
    await emit("}");
  };

  try {
    await walk(value);
    await flush(true);
    file.end();
    await once(file, "finish");
    return written;
  } catch (error) {
    file.destroy();
    throw error;
  }
}
