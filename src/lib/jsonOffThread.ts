/**
 * D257 / D262 — JSON.parse of `/data/state.json` runs in a worker
 * thread (the worker reads the file itself). JSON.stringify of the
 * dump must **not** go through `workerData`: structuredClone of a
 * ~100MB state pinned the event loop 31–47s and the freeze watchdog
 * exited (prod 2026-10-13). Stringify uses the D249 yielding walk.
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
  // D262 — never structuredClone the dump onto a worker. The clone
  // ran on the main thread and froze the loop longer than stringify.
  return stringifyYielding(value);
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

/** D269 — worker reads the file, slims campaigns[], posts the thin page. */
export async function parseSlimEmailAccountsFile<T = unknown>(
  filePath: string,
): Promise<T> {
  try {
    return (await runWorker({ op: "parseSlimEmailAccountsFile", filePath })) as T;
  } catch (error) {
    const mapped = asFsError(error);
    if (mapped.code === "ENOENT") throw mapped;
    console.warn("[state] off-thread slim email-accounts parse failed; in-process fallback", error);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  }
}
