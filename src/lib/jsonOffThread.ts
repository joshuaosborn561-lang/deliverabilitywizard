/**
 * D257 — JSON.stringify / JSON.parse of `/data/state.json` run in a
 * worker thread so a 100MB+ dump cannot pin the event loop. The worker
 * reads a file itself (parse) or receives a structured-clone of the
 * already-pruned state (stringify). Fallback is the D249 yielding walk
 * / in-process parse if the worker cannot start.
 */

import { Worker } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { stringifyYielding } from "./stringifyYielding.js";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const job = workerData;
try {
  if (job.op === "stringify") {
    parentPort.postMessage({ ok: true, value: JSON.stringify(job.value) });
  } else if (job.op === "parseFile") {
    parentPort.postMessage({
      ok: true,
      value: JSON.parse(readFileSync(job.filePath, "utf8")),
    });
  } else if (job.op === "parseText") {
    parentPort.postMessage({ ok: true, value: JSON.parse(job.text) });
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
  value: unknown;
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
      if (msg.ok) finish(() => resolve(msg.value));
      else finish(() => reject(new Error(msg.error)));
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

export async function stringifyOffThread(value: unknown): Promise<string> {
  try {
    const body = await runWorker({ op: "stringify", value });
    if (typeof body !== "string") {
      throw new Error("off-thread stringify did not return a string");
    }
    return body;
  } catch (error) {
    console.warn("[state] off-thread stringify failed; yielding fallback", error);
    return stringifyYielding(value);
  }
}

function asFsError(error: unknown): NodeJS.ErrnoException {
  const message = error instanceof Error ? error.message : String(error);
  const err = new Error(message) as NodeJS.ErrnoException;
  if (/ENOENT/.test(message)) err.code = "ENOENT";
  return err;
}

export async function parseFileOffThread<T>(filePath: string): Promise<T> {
  try {
    return (await runWorker({ op: "parseFile", filePath })) as T;
  } catch (error) {
    const mapped = asFsError(error);
    if (mapped.code === "ENOENT") throw mapped;
    console.warn("[state] off-thread parse failed; in-process fallback", error);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  }
}

export async function parseTextOffThread<T>(text: string): Promise<T> {
  try {
    return (await runWorker({ op: "parseText", text })) as T;
  } catch (error) {
    console.warn("[state] off-thread parseText failed; in-process fallback", error);
    return JSON.parse(text) as T;
  }
}
