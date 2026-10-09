/**
 * D249 — compact JSON without pinning the event loop.
 *
 * Production after D247 still called `JSON.stringify(this.state)` on the
 * main thread after every stage. A large `/data/state.json` blocked the
 * loop for ~100s per checkpoint (and once for 12+ minutes). The freeze
 * watchdog then exited before `writeFile`/`rename`, so stamps never
 * landed. Walk the graph in small slices and `setImmediate` between
 * them so `/health`, cron, and the watchdog can breathe.
 */

export const STRINGIFY_YIELD_EVERY = 8;
/** D252 — joining already-walked parts can be a 100s slice on a large state. */
export const STRINGIFY_JOIN_CHUNK = 32;

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
