/**
 * Collapse a run's error list into distinct shapes for logging.
 *
 * A bare count is unreadable: a run reporting "errors: 40" gave no way to tell
 * 40 purged test ids from 40 failed campaign removals, and the strings were
 * never written anywhere. Grouping by shape keeps one repeated fault to one
 * line while still naming it.
 */
export interface ErrorShape {
  /** How many raw errors collapsed into this shape. */
  count: number;
  /** One real, unredacted example — the shape itself is lossy. */
  sample: string;
}

/** Ids and addresses vary per occurrence; the shape is what repeats. */
export function errorShapeKey(message: string): string {
  return String(message)
    .replace(/[\w.+-]+@[\w.-]+/g, "<email>")
    .replace(/\b\d{4,}\b/g, "#")
    .slice(0, 120);
}

export function summarizeErrors(errors: readonly string[]): ErrorShape[] {
  const byShape = new Map<string, ErrorShape>();
  for (const raw of errors) {
    const key = errorShapeKey(raw);
    const seen = byShape.get(key);
    if (seen) seen.count += 1;
    else byShape.set(key, { count: 1, sample: String(raw).slice(0, 200) });
  }
  return [...byShape.values()].sort((a, b) => b.count - a.count);
}
