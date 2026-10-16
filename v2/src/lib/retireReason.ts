/**
 * D146 / D49 — a burned-retire recommendation is one sentence naming why.
 */

export function burnedRetireReason(opts: {
  domain: string;
  bounceClass?: string;
  smtp?: string;
  isolationVerdict?: string;
  failingEmails?: string[];
}): string {
  const host = opts.domain.trim().toLowerCase() || "this domain";
  if (opts.bounceClass === "tenant_outbound_block" || /5\.1\.8|as\(42004\)/i.test(opts.smtp ?? "")) {
    return `Microsoft 5.1.8 outbound block on ${host} — the provider called this sender bad.`;
  }
  if (opts.isolationVerdict === "INFRA") {
    const n = opts.failingEmails?.length ?? 0;
    return n
      ? `Known-good placement failed on ${host} (${n} inbox${n === 1 ? "" : "es"}), so the sender domain is burned.`
      : `Known-good placement failed on ${host}, so the sender domain is burned.`;
  }
  if (opts.bounceClass === "sender_blocked") {
    return `Smartlead marked ${host} sender-blocked, so restaff must not put it back.`;
  }
  return `Placement and bounce evidence on ${host} say the sender domain should be retired.`;
}

export function assertOneSentenceReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("burned-retire recommendation needs a one-sentence reason");
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length !== 1) {
    throw new Error("burned-retire recommendation must be exactly one sentence");
  }
  return trimmed;
}
