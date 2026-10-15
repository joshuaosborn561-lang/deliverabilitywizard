import { redactSecrets, requestLabel } from "../lib/redact.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export type ScheduleFn = <T>(fn: () => Promise<T>) => Promise<T>;

export async function requestJson<T>(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const label = requestLabel(method, url);
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 429) {
    throw new RateLimitError(`${label} → 429`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} → ${res.status} ${redactSecrets(body.slice(0, 200))}`);
  }
  return (await res.json()) as T;
}

export function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return requestJson<T>(url, { method: "GET", headers });
}

export function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  return requestJson<T>(url, { method: "POST", headers, body });
}
