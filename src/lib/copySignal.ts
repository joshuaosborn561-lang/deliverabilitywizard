/**
 * D93/D96 — the word hunt is not "Outlook buried, Gmail fine". It is:
 * this campaign test is not inboxing on an ESP, the known-good email
 * from those same domains is fine on every scored ESP, and unwarmed
 * senders with that copy are also failing an ESP.
 *
 * The old D28/D36 provider-split classifier is deleted (D129) —
 * provider divergence is not a Slack or rotation driver.
 */

export interface ProviderInboxSplit {
  name: string;
  inboxPercent: number;
}

export function anyEspBelowThreshold(
  providers: ProviderInboxSplit[],
  threshold = 80,
): boolean {
  return providers.some((row) => row.inboxPercent < threshold);
}

export function allEspsAtOrAbove(
  providers: ProviderInboxSplit[],
  threshold = 80,
): boolean | null {
  if (!providers.length) return null;
  return providers.every((row) => row.inboxPercent >= threshold);
}
