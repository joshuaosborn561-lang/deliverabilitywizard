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
  } = options;
  const url = buildUrl(baseUrl, path, apiKey, query);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
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

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const backoff = Math.min(30_000, 500 * 2 ** attempt);
          await sleep(backoff);
          continue;
        }
      }

      if (!response.ok) {
        // Always keep the status in the message. Smartlead 5xx bodies are
        // often a vendor SQL string ("permission denied for table …") with
        // no "HTTP 500", and isUpstream5xxNoise only matches HTTP 5xx.
        const statusLabel = `HTTP ${response.status}`;
        const detail =
          typeof parsed === "object" &&
          parsed !== null &&
          ("message" in parsed || "error" in parsed)
            ? String(
                (parsed as { message?: unknown; error?: unknown }).message ??
                  (parsed as { error?: unknown }).error,
              )
            : "";
        const message =
          detail && detail !== statusLabel
            ? `${statusLabel}: ${detail}`
            : statusLabel;
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
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "request failed"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
