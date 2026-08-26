/**
 * Decide whether a weak placement result looks like *copy/offer* spam
 * filtering rather than a single broken mailbox (D28).
 *
 * Pattern borrowed from the Slack placement takeaway: Outlook buried while
 * Gmail is fine usually means Microsoft is filtering the message content;
 * every provider weak is ambiguous; one provider weak is mailbox/ESP local.
 *
 * D36 adds the provider-agnostic case. The original rule only names Outlook
 * as the buried side, so a Gmail-buried offer read as "local to that ESP".
 * What actually indicates copy is *divergence*: the same senders reaching one
 * provider's inbox while another buries them. Which provider is which does not
 * matter, and a mailbox fault cannot explain it — the same mailbox is fine on
 * the other side.
 */

/**
 * Points between the best and worst provider before divergence alone is
 * treated as a copy signal. Sized off the Goliath L3 Manufacturing Defense
 * campaigns: identical senders read 100% Office365 / 36% G Suite (a 64-point
 * spread) on the AirPods offer, and 100% / 100% on the Tickets offer.
 */
export const COPY_DIVERGENCE_POINTS = 40;

export type CopySignalKind =
  | "copy_likely"
  | "ambiguous"
  | "mailbox_or_esp"
  | "none";

export interface ProviderInboxSplit {
  name: string;
  inboxPercent: number;
}

export interface CopySignal {
  kind: CopySignalKind;
  reason: string;
}

export function classifyCopySignal(
  providers: ProviderInboxSplit[],
  threshold = 80,
): CopySignal {
  const weak = providers.filter((p) => p.inboxPercent < threshold);
  if (!weak.length) {
    return { kind: "none", reason: "All scored providers are at or above threshold." };
  }

  const outlook = weak.find((p) =>
    /outlook|office\s*365|o365|microsoft/i.test(p.name),
  );
  const gmail = providers.find((p) => /g\s*suite|gmail|google/i.test(p.name));

  if (
    outlook &&
    outlook.inboxPercent < 20 &&
    (!gmail || gmail.inboxPercent >= 50)
  ) {
    return {
      kind: "copy_likely",
      reason:
        "Outlook/Microsoft is mostly spam while Gmail is healthier — usually the copy/offer, not one mailbox.",
    };
  }

  // D36 — provider-agnostic divergence. One provider is healthy while another
  // is far below it, using the same senders. A broken mailbox cannot land 100%
  // on one provider and be buried on another, so the message is the variable.
  // Deliberately checked before the "one weak provider = mailbox/ESP local"
  // branch, which is what previously swallowed this case.
  const best = providers.reduce((a, b) =>
    b.inboxPercent > a.inboxPercent ? b : a,
  );
  const worst = providers.reduce((a, b) =>
    b.inboxPercent < a.inboxPercent ? b : a,
  );
  if (
    best.inboxPercent >= threshold &&
    best.inboxPercent - worst.inboxPercent >= COPY_DIVERGENCE_POINTS
  ) {
    return {
      kind: "copy_likely",
      reason: `${worst.name} is at ${worst.inboxPercent.toFixed(0)}% while ${best.name} is at ${best.inboxPercent.toFixed(0)}% on the same senders — a ${Math.round(best.inboxPercent - worst.inboxPercent)}-point split points at the copy/offer, not the mailboxes.`,
    };
  }

  if (weak.length >= 2 && weak.every((p) => p.inboxPercent < 40)) {
    return {
      kind: "ambiguous",
      reason:
        "Inbox is weak across providers — could be copy/offer, domains, or both.",
    };
  }

  if (weak.length === 1) {
    return {
      kind: "mailbox_or_esp",
      reason: `${weak[0]!.name} alone is below ${threshold}% — looks local to that ESP/mailbox.`,
    };
  }

  return {
    kind: "ambiguous",
    reason: `Several providers under ${threshold}% without a clear copy-only pattern.`,
  };
}

/** True when remediation should hold off benching senders and push copy review. */
export function shouldDeferSenderRotationForCopy(signal: CopySignal): boolean {
  return signal.kind === "copy_likely";
}

/**
 * D93/D96 — the word hunt is not “Outlook buried, Gmail fine”. It is:
 * this campaign test is not inboxing on an ESP, the known-good email
 * from those same domains is fine on every scored ESP, and unwarmed
 * senders with that copy are also failing an ESP.
 */
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
