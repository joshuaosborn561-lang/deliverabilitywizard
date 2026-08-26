/**
 * D81 / D82 — a POC client is a flag, not a pile of Goliath-named rules.
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

export function pocClientId(
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  patterns: string[] = ["goliath"],
): number | null {
  for (const client of clients) {
    const hay = `${client.name ?? ""} ${client.logo ?? ""}`;
    if (isPocClient(hay, patterns)) return client.id;
  }
  return null;
}
