/**
 * D81 — a POC client is a flag, not a pile of Goliath-named rules.
 * Goliath is the current POC. Floor, signatures, and canaries are the
 * same for every client.
 */

export function isPocClient(
  hay: string,
  patterns: string[] = ["goliath"],
): boolean {
  const text = hay.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return Boolean(needle) && text.includes(needle);
  });
}
