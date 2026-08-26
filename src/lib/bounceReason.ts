/**
 * D140 — a bounce count is a symptom; the SMTP reason is the diagnosis.
 * Live 2026-08-26: two campaigns "bounced" 25-31% of everything they sent
 * and the lists were blamed — the actual reason on every sampled bounce
 * was `550 5.7.233`, Microsoft's tenant-wide daily external-recipient cap
 * (TERRL) on the cleartechco tenant. Verified lists bounce 3-4%; a spike
 * is almost always the provider talking, and what it says decides the
 * remedy: a tenant cap needs volume/tenant changes, an invalid-recipient
 * wave needs the list re-verified, a content block feeds the canary
 * diagnosis (spintax escalation is the D141 follow-up).
 */

export type BounceClass =
  | "tenant_rate_limit"
  | "invalid_recipient"
  | "content_block"
  | "other";

/** Order matters: the tenant-cap text also contains generic 550 markers. */
export function classifyBounceText(text: string): BounceClass {
  const hay = text.toLowerCase();
  if (
    /5\.7\.233/.test(hay) ||
    /tenant (?:has )?exceeded/.test(hay) ||
    /tenant external recipient rate limit/.test(hay) ||
    /external recipient rate limit/.test(hay)
  ) {
    return "tenant_rate_limit";
  }
  if (
    /5\.1\.[0-9]/.test(hay) ||
    /user unknown|no such user|recipient (?:address )?(?:rejected|not found|unknown)|address(?:ee)? (?:rejected|unknown|not found)|does ?n[o']t exist|mailbox (?:unavailable|not found|does not exist)|invalid recipient|no mailbox/.test(
      hay,
    )
  ) {
    return "invalid_recipient";
  }
  if (
    /5\.7\.[01]\b/.test(hay) ||
    /spam|content rejected|blocked using|block list|blacklist|listed at|poor reputation|reputation|policy reasons|message rejected|554/.test(
      hay,
    )
  ) {
    return "content_block";
  }
  return "other";
}

export interface BounceSample {
  leadEmail: string;
  senderEmail: string | null;
  bounceClass: BounceClass;
  /** First line of the remote server's reason, for humans. */
  snippet: string;
}

/** Pull the SMTP reason out of an Exchange/Google NDR body. */
export function bounceReasonSnippet(body: string): string {
  const remote = /remote server returned '([^']+)'/i.exec(body);
  if (remote?.[1]) return remote[1].slice(0, 200);
  const plain = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const code = /\b([45]\d{2}[- ][\d.]+[^.]{0,160})/.exec(plain);
  if (code?.[1]) return code[1].slice(0, 200);
  return plain.slice(0, 160);
}

export function summarizeBounceSamples(samples: BounceSample[]): {
  dominant: BounceClass | null;
  summary: string;
} {
  if (!samples.length) return { dominant: null, summary: "no samples readable" };
  const counts = new Map<BounceClass, number>();
  for (const sample of samples) {
    counts.set(sample.bounceClass, (counts.get(sample.bounceClass) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0]![0];
  const summary = ranked
    .map(([cls, count]) => `${cls}×${count}`)
    .join(" ");
  return { dominant, summary };
}

/** Sender domains seen in the samples, for tenant-level attribution. */
export function sampleSenderDomains(samples: BounceSample[]): string[] {
  const domains = new Set<string>();
  for (const sample of samples) {
    const domain = sample.senderEmail?.split("@")[1]?.toLowerCase();
    if (domain) domains.add(domain);
  }
  return [...domains];
}
