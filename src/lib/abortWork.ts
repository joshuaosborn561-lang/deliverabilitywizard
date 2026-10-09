/**
 * D251 — a stage AbortSignal must stop the work it started.
 * raceStep rejects on timeout even when the promise ignores the
 * signal; callers still have to check it or placement keeps running.
 */

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  throw error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const message =
    "message" in error ? String((error as { message?: unknown }).message) : "";
  return (
    name === "AbortError" ||
    /operation was aborted|The operation was aborted/i.test(message)
  );
}
