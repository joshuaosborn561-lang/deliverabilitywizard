/**
 * D257 / D262 / D271 — JSON.parse of `/data/state.json` runs in a worker
 * thread (the worker reads the file itself). JSON.stringify of the
 * dump must **not** go through `workerData`: structuredClone of a
 * ~100MB state pinned the event loop 31–47s and the freeze watchdog
 * exited (prod 2026-10-13). Stringify uses the D249 yielding walk, and
 * D271 writes the dump to disk as it walks so the join cannot stall.
 *
 * D271 — posting the parsed graph back via one `postMessage` is the
 * same structuredClone stall on load. The worker hands keys / array
 * slices on request so the main thread can yield between them.
 */

import { Worker } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import { runWithStallScopeAsync } from "./eventLoopAttribution.js";
import { stringifyYielding, stringifyYieldingToFile, yieldEventLoop } from "./stringifyYielding.js";

const PARSE_CHUNK_ARRAY = 32;
const PARSE_FAT_OBJECT_KEYS = 8;
const SMALL_JSON_CHARS = 256_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");

function getPath(root, path) {
  let node = root;
  for (const key of path) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

function fatKind(node) {
  if (Array.isArray(node) && node.length > ${PARSE_CHUNK_ARRAY}) {
    return { mode: "array", length: node.length };
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    const nestedFat = keys.length > ${PARSE_FAT_OBJECT_KEYS} || keys.some((k) => {
      const child = node[k];
      return (Array.isArray(child) && child.length > ${PARSE_CHUNK_ARRAY}) ||
        (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length > ${PARSE_FAT_OBJECT_KEYS});
    });
    if (nestedFat) return { mode: "object", keys };
  }
  return { mode: "value", value: node };
}

const job = workerData;
try {
  if (job.op === "stringify") {
    parentPort.postMessage({ ok: true, value: JSON.stringify(job.value) });
  } else if (job.op === "parseFile") {
    parentPort.postMessage({
      ok: true,
      value: JSON.parse(readFileSync(job.filePath, "utf8")),
    });
  } else if (job.op === "parseFileChunked") {
    const root = JSON.parse(readFileSync(job.filePath, "utf8"));
    parentPort.postMessage({ ok: true, mode: "ready" });
    parentPort.on("message", (msg) => {
      try {
        if (!msg || msg.op === "close") {
          parentPort.postMessage({ mode: "end" });
          return;
        }
        if (msg.op === "get") {
          parentPort.postMessage(fatKind(getPath(root, msg.path || [])));
          return;
        }
        if (msg.op === "slice") {
          const node = getPath(root, msg.path || []);
          const start = msg.start || 0;
          const end = msg.end || start;
          parentPort.postMessage({
            mode: "value",
            value: Array.isArray(node) ? node.slice(start, end) : [],
          });
        }
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } else if (job.op === "parseText") {
    parentPort.postMessage({ ok: true, value: JSON.parse(job.text) });
  } else if (job.op === "parseSlimEmailAccountsFile") {
    const page = JSON.parse(readFileSync(job.filePath, "utf8"));
    if (!Array.isArray(page)) {
      parentPort.postMessage({ ok: true, value: [] });
    } else {
      const slim = page.map((account) => {
        if (!account || typeof account !== "object") return account;
        let ids = Array.isArray(account.campaign_ids)
          ? account.campaign_ids.filter((n) => typeof n === "number" && Number.isFinite(n))
          : [];
        if (!ids.length && Array.isArray(account.campaigns)) {
          ids = account.campaigns
            .map((row) => (row && typeof row === "object" ? (row.id ?? row.campaign_id) : null))
            .filter((n) => typeof n === "number" && Number.isFinite(n));
        }
        const next = Object.assign({}, account, { campaign_ids: ids });
        delete next.campaigns;
        return next;
      });
      parentPort.postMessage({ ok: true, value: slim });
    }
  } else {
    parentPort.postMessage({ ok: false, error: "unknown op" });
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

interface WorkerOk {
  ok: true;
  value?: unknown;
  mode?: string;
  keys?: string[];
  length?: number;
}
interface WorkerErr {
  ok: false;
  error: string;
}

function runWorker(workerData: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData,
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      fn();
    };
    worker.once("message", (msg: WorkerOk | WorkerErr) => {
      if (!msg || typeof msg !== "object") {
        finish(() => reject(new Error("off-thread JSON worker returned nothing")));
        return;
      }
      if ("ok" in msg && msg.ok === false) {
        finish(() => reject(new Error(msg.error)));
        return;
      }
      if (msg.ok) finish(() => resolve(msg.value));
      else finish(() => reject(new Error("off-thread JSON worker returned nothing")));
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`off-thread JSON worker exited ${code}`)));
      }
    });
  });
}

interface ChunkMsg {
  ok?: boolean;
  mode?: "ready" | "end" | "value" | "object" | "array";
  value?: unknown;
  keys?: string[];
  length?: number;
  error?: string;
}

async function parseFileChunked<T>(filePath: string): Promise<T> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { op: "parseFileChunked", filePath },
  });
  const pending: Array<(msg: ChunkMsg) => void> = [];
  let closed = false;

  const next = (): Promise<ChunkMsg> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("off-thread JSON worker closed"));
        return;
      }
      pending.push(resolve);
    });

  worker.on("message", (msg: ChunkMsg) => {
    const waiter = pending.shift();
    if (waiter) waiter(msg);
  });

  const fail = (error: Error): never => {
    closed = true;
    worker.terminate().catch(() => undefined);
    throw error;
  };

  worker.once("error", (error) => {
    closed = true;
    const waiter = pending.shift();
    if (waiter) waiter({ ok: false, error: error.message });
  });

  try {
    const ready = await next();
    if (!ready || ("ok" in ready && ready.ok === false)) {
      return fail(new Error("error" in ready && ready.error ? ready.error : "chunked parse failed"));
    }
    if (ready.mode !== "ready") {
      return fail(new Error("chunked parse did not start"));
    }

    const ask = async (payload: Record<string, unknown>): Promise<ChunkMsg> => {
      worker.postMessage(payload);
      const msg = await next();
      if (msg && "ok" in msg && msg.ok === false) {
        throw new Error(msg.error);
      }
      return msg;
    };

    const readNode = async (path: Array<string | number>): Promise<unknown> => {
      const msg = await ask({ op: "get", path });
      if (msg.mode === "array") {
        const length = msg.length ?? 0;
        const out: unknown[] = [];
        for (let i = 0; i < length; i += PARSE_CHUNK_ARRAY) {
          const slice = await ask({
            op: "slice",
            path,
            start: i,
            end: Math.min(i + PARSE_CHUNK_ARRAY, length),
          });
          if (Array.isArray(slice.value)) out.push(...slice.value);
          await yieldEventLoop();
        }
        return out;
      }
      if (msg.mode === "object") {
        const out: Record<string, unknown> = {};
        for (const key of msg.keys ?? []) {
          out[key] = await readNode([...path, key]);
          await yieldEventLoop();
        }
        return out;
      }
      return msg.value;
    };

    const value = (await readNode([])) as T;
    worker.postMessage({ op: "close" });
    await worker.terminate().catch(() => undefined);
    return value;
  } catch (error) {
    await worker.terminate().catch(() => undefined);
    throw error;
  }
}

export async function stringifyOffThread(value: unknown): Promise<string> {
  // D262 — never structuredClone the dump onto a worker. The clone
  // ran on the main thread and froze the loop longer than stringify.
  return runWithStallScopeAsync("json.stringify:yielding", () =>
    stringifyYielding(value),
  );
}

/** D271 — write `/data/state.json` without joining the blob on this thread. */
export async function stringifyOffThreadToFile(
  value: unknown,
  filePath: string,
): Promise<number> {
  return runWithStallScopeAsync("json.stringify:state", () =>
    stringifyYieldingToFile(value, filePath),
  );
}

function asFsError(error: unknown): NodeJS.ErrnoException {
  const message = error instanceof Error ? error.message : String(error);
  const err = new Error(message) as NodeJS.ErrnoException;
  if (/ENOENT/.test(message)) err.code = "ENOENT";
  return err;
}

export async function parseFileOffThread<T>(filePath: string): Promise<T> {
  return runWithStallScopeAsync("json.parseFile", async () => {
    try {
      const info = await stat(filePath);
      if (info.size < SMALL_JSON_CHARS) {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw) as T;
      }
      return await parseFileChunked<T>(filePath);
    } catch (error) {
      const mapped = asFsError(error);
      if (mapped.code === "ENOENT") throw mapped;
      // D271 — do not JSON.parse a fat dump on the main thread as fallback.
      // Retry once via the original one-shot worker (still off-thread).
      console.warn("[state] chunked parse failed; one-shot worker retry", error);
      try {
        return (await runWorker({ op: "parseFile", filePath })) as T;
      } catch (retryError) {
        const retryMapped = asFsError(retryError);
        if (retryMapped.code === "ENOENT") throw retryMapped;
        throw retryMapped;
      }
    }
  });
}

export async function parseTextOffThread<T>(text: string): Promise<T> {
  return runWithStallScopeAsync("json.parseText", async () => {
    if (text.length < SMALL_JSON_CHARS) {
      try {
        return (await runWorker({ op: "parseText", text })) as T;
      } catch (error) {
        console.warn("[state] off-thread parseText failed; in-process fallback", error);
        return JSON.parse(text) as T;
      }
    }
    try {
      return (await runWorker({ op: "parseText", text })) as T;
    } catch (error) {
      console.warn("[state] off-thread parseText failed; not parsing fat JSON on main", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

/** D269 — worker reads the file, slims campaigns[], posts the thin page. */
export async function parseSlimEmailAccountsFile<T = unknown>(
  filePath: string,
): Promise<T> {
  return runWithStallScopeAsync("json.parseSlimEmailAccounts", async () => {
    try {
      return (await runWorker({ op: "parseSlimEmailAccountsFile", filePath })) as T;
    } catch (error) {
      const mapped = asFsError(error);
      if (mapped.code === "ENOENT") throw mapped;
      // D271 — a fat fetch_campaigns page must not JSON.parse on main.
      console.warn("[state] off-thread slim email-accounts parse failed", error);
      throw mapped;
    }
  });
}
