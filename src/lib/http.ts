import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { runWithStallScopeAsync } from "./eventLoopAttribution.js";
import { parseFileOffThread } from "./jsonOffThread.js";
import { pauseWhileSlackInteraction } from "./healthCpuPause.js";
import { yieldEventLoop } from "./stringifyYielding.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors (default 4). */
  retries?: number;
  /** Optional caller abort (D247 step timeout). */
  signal?: AbortSignal;
  /** D257 — shared Smartlead limiter learns a 429 from any stage. */
  onRateLimit?: (retryAfterMs?: number) => void;
  /**
   * D269 — replace JSON.parse for fat responses (email-accounts pages
   * with fetch_campaigns). Must not structuredClone the raw graph.
   */
  parseJson?: (text: string) => Promise<unknown> | unknown;
  /**
   * D270 — parse an OK body from a temp file. The response is streamed
   * to disk in chunks so `response.text()` cannot pin the event loop
   * on a 10–50MB fetch_campaigns page. Error / 429 bodies stay small
   * and use JSON.parse.
   */
  parseJsonFile?: (filePath: string) => Promise<unknown> | unknown;
}

function buildUrl(
  baseUrl: string,
  path: string,
  apiKey: string,
  query?: RequestOptions["query"],
): string {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("api_key", apiKey);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Yield the event loop after this many streamed bytes (D270). */
export const STREAM_BODY_YIELD_BYTES = 256_000;
/** D271 — never Buffer.from / write a multi-MB fetch chunk in one slice. */
export const STREAM_BODY_SLICE_BYTES = 64_000;
/** D271 — OK bodies this large parse off-thread even without parseJsonFile. */
export const FAT_JSON_PARSE_BYTES = 256_000;

export async function streamResponseToFile(
  response: Response,
  filePath: string,
  opts: { signal?: AbortSignal; yieldEveryBytes?: number } = {},
): Promise<number> {
  const yieldEvery = opts.yieldEveryBytes ?? STREAM_BODY_YIELD_BYTES;
  const body = response.body;
  if (!body) {
    const text = await response.text();
    await writeFile(filePath, text, "utf8");
    return Buffer.byteLength(text);
  }
  const file = createWriteStream(filePath);
  const reader = body.getReader();
  let written = 0;
  let sinceYield = 0;
  try {
    for (;;) {
      if (opts.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      // D271 — undici can hand the whole 10–50MB page as one read().
      // Slice it so Buffer.from + write cannot pin the loop 18–25s.
      for (let offset = 0; offset < value.byteLength; offset += STREAM_BODY_SLICE_BYTES) {
        const end = Math.min(offset + STREAM_BODY_SLICE_BYTES, value.byteLength);
        const chunk = Buffer.from(value.subarray(offset, end));
        if (!file.write(chunk)) await once(file, "drain");
        written += chunk.byteLength;
        sinceYield += chunk.byteLength;
        // D294 — yield every 64KB slice (not every 256KB) so a Slack
        // tap can ack inside 3s while a fat Smartlead page streams.
        if (sinceYield >= Math.min(yieldEvery, STREAM_BODY_SLICE_BYTES)) {
          sinceYield = 0;
          await yieldEventLoop();
          await pauseWhileSlackInteraction({ label: "fs.streamResponseToFile" });
        }
      }
    }
    file.end();
    await once(file, "finish");
    return written;
  } catch (error) {
    file.destroy();
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

function tmpBodyPath(): string {
  return `/tmp/sl-body-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

async function parseOkBody(
  response: Response,
  options: {
    parseJson?: RequestOptions["parseJson"];
    parseJsonFile?: RequestOptions["parseJsonFile"];
    signal?: AbortSignal;
  },
): Promise<unknown> {
  // D271 — always stream OK Smartlead bodies. content-length is often
  // missing; response.text() of a fat page is the leftover 18–25s stall.
  const tmp = tmpBodyPath();
  try {
    const size = await runWithStallScopeAsync("fs.streamResponseToFile", () =>
      streamResponseToFile(response, tmp, { signal: options.signal }),
    );
    if (options.parseJsonFile) {
      return await options.parseJsonFile(tmp);
    }
    if (size >= FAT_JSON_PARSE_BYTES && !options.parseJson) {
      return await parseFileOffThread(tmp);
    }
    const text = await readFile(tmp, "utf8");
    if (!text) return null;
    try {
      return options.parseJson ? await options.parseJson(text) : JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function apiRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    query,
    body,
    headers = {},
    timeoutMs = 60_000,
    retries = 4,
    signal,
    onRateLimit,
    parseJson,
    parseJsonFile,
  } = options;
  const url = buildUrl(baseUrl, path, apiKey, query);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const transient = response.status === 429 || response.status >= 500;
      const parsed = transient || !response.ok
        ? await parseErrorBody(response)
        : await parseOkBody(response, {
            parseJson,
            parseJsonFile,
            signal: controller.signal,
          });

      if (transient) {
        if (response.status === 429) {
          onRateLimit?.(Math.min(30_000, 500 * 2 ** attempt));
        }
        if (attempt < retries) {
          const backoff = Math.min(30_000, 500 * 2 ** attempt);
          await sleep(backoff);
          continue;
        }
      }

      if (!response.ok) {
        const message =
          typeof parsed === "object" &&
          parsed !== null &&
          ("message" in parsed || "error" in parsed)
            ? String(
                (parsed as { message?: unknown; error?: unknown }).message ??
                  (parsed as { error?: unknown }).error,
              )
            : `HTTP ${response.status}`;
        throw new ApiError(message, response.status, parsed);
      }

      return parsed as T;
    } catch (error) {
      // Our AbortController fired — rewrite the opaque DOMException
      // ("This operation was aborted") into a clear timeout so callers and
      // the failure classifier can treat it as transient network noise.
      if (controller.signal.aborted && isAbortError(error)) {
        lastError = timeoutError(timeoutMs);
      } else {
        lastError = error;
      }
      if (lastError instanceof ApiError) throw lastError;
      if (attempt < retries) {
        const backoff = Math.min(30_000, 500 * 2 ** attempt);
        await sleep(backoff);
        continue;
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "request failed"));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "request failed"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Slack / InboxKit fetches — 30s so a hung webhook cannot pin a stage (D247). */
export const EXTERNAL_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onParentAbort);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const message =
    "message" in error ? String((error as { message?: unknown }).message) : "";
  return (
    name === "AbortError" ||
    /operation was aborted|aborted|The operation was aborted/i.test(message)
  );
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
