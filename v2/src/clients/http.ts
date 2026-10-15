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

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { method: "GET", headers });
  if (res.status === 429) {
    throw new RateLimitError(`GET ${url} → 429`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
