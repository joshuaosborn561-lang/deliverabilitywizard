/**
 * Decide whether a weak placement result looks like *copy/offer* spam
 * filtering rather than a single broken mailbox (D28).
 *
 * Pattern borrowed from the Slack placement takeaway: Outlook buried while
 * Gmail is fine usually means Microsoft is filtering the message content;
 * every provider weak is ambiguous; one provider weak is mailbox/ESP local.
 */

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
