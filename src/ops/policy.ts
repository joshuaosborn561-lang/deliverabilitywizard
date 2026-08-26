import type { OpsRole } from "./auth.js";

export type OpsIntent =
  | { type: "help" }
  | { type: "status" }
  | { type: "deliverability" }
  | { type: "dns" }
  | { type: "campaigns" }
  | { type: "campaign_setup" }
  | { type: "reconnect" }
  | { type: "approvals" }
  | { type: "ask_cursor"; message: string }
  | { type: "denied"; reason: string }
  | { type: "unknown" };

const EMAIL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function classifyOpsMessage(
  rawMessage: string,
  role: OpsRole,
): OpsIntent {
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  if (!lower || /^(help|commands|what can i do)\??$/.test(lower)) {
    return { type: "help" };
  }

  if (/\b(rotate|bench|swap|pull)\b/i.test(message) && EMAIL.test(message)) {
    return {
      type: "denied",
      reason:
        "Manual mailbox rotation is retired (D51/D130): pulls are kill-only. Ask Josh to retire the domain from the burned-domain Slack, and health will backfill.",
    };
  }

  if (
    /\b(buy|purchase|order|spend|top[\s-]?up wallet|add credits?)\b/i.test(
      message,
    )
  ) {
    return {
      type: "denied",
      reason:
        role === "owner"
          ? "Purchases are never executed from chat. Use the owner-only approval panel for an already generated request; new spend must originate from an approval-gated operation (D4/D15)."
          : "Cayden cannot buy domains, mailboxes, or credits. Real-money actions require Josh through the spend approval gateway (D4/D15).",
    };
  }

  if (/\b(delete|purge|destroy|cancel mailbox|remove domain)\b/i.test(message)) {
    return {
      type: "denied",
      reason:
        "Destructive mailbox/domain actions are not allowlisted in chat. Blacklist teardown requires a specific owner-approved request and exact-domain guard.",
    };
  }

  if (
    /\b(disable|bypass|skip)\b.*\b(warmup|hold|approval|safety|token)\b/i.test(
      message,
    )
  ) {
    return {
      type: "denied",
      reason:
        "Safety gates cannot be bypassed from the operations console: the 21-day warmup gate and spend approval are owner decisions (D50/D105, D4).",
    };
  }

  if (
    /\b(change|set|raise|lower|edit)\b.*\b(50|30|threshold|sender|daily|limit|config)\b/i.test(
      message,
    )
  ) {
    return {
      type: "denied",
      reason:
        "The console cannot change fleet policy. The staffing floor (half each client's inboxes) and the 30/day mailbox cap are owner decisions and require a reviewed code/config change (D82, D11/D24).",
    };
  }

  if (
    /\b(deploy to production|ship to production|railway up|force push)\b/i.test(
      message,
    )
  ) {
    return {
      type: "denied",
      reason:
        "Production deploys only happen from reviewed merges to main. Ask the Cursor agent to open a PR instead of pushing live.",
    };
  }

  if (/\b(remediate all|run remediation|rotate all)\b/i.test(message)) {
    return {
      type: "denied",
      reason:
        "Bulk remediation is intentionally unavailable in chat. Inspect specific evidence and rotate one mailbox at a time, or use the protected owner runbook.",
    };
  }

  if (/\b(approval|approvals|pending spend)\b/i.test(message)) {
    return { type: "approvals" };
  }
  if (/\b(reconnect|reauth|disconnected)\b/i.test(message)) {
    return { type: "reconnect" };
  }
  if (/\b(dns|spf|dmarc|mx)\b/i.test(message)) return { type: "dns" };
  if (
    /\b(campaign setup|setup prompt|how (do|to) (we )?launch|new campaign rules)\b/i.test(
      message,
    )
  ) {
    return { type: "campaign_setup" };
  }
  if (/\b(campaigns?|sender count|headcount|coverage)\b/i.test(message)) {
    return { type: "campaigns" };
  }
  if (/\b(deliverability|placement|inbox|blacklist|check now)\b/i.test(message)) {
    return { type: "deliverability" };
  }
  if (/\b(status|summary|dashboard|how are things)\b/i.test(message)) {
    return { type: "status" };
  }

  // Explicit "ask cursor/agent …" or any unrecognized freeform → Cursor Grok.
  const askMatch = message.match(
    /^(?:ask\s+(?:cursor|agent|grok)\s*[:\-]?\s*)([\s\S]+)$/i,
  );
  if (askMatch?.[1]?.trim()) {
    return { type: "ask_cursor", message: askMatch[1].trim() };
  }
  return { type: "ask_cursor", message };
}

export function opsHelp(role: OpsRole): string {
  const lines = [
    "Fast allowlisted ops (run locally, no Cursor charge):",
    "• “Check deliverability” — placement results plus campaign and DNS audits",
    "• “Check DNS” — SPF/DMARC/MX audit without changing DNS",
    "• “Audit campaigns” — sender floor, rest piles, and placement-test coverage",
    "• “Campaign setup” — D43 rails for launching a new campaign",
    "• “Reconnect disconnected mailboxes”",
    "• “Status” — pool, rest piles and recent runs",
  ];
  if (role === "owner") {
    lines.push("• “Approvals” — owner-only pending spend decisions");
  }
  lines.push(
    "",
    "Anything else goes to Cursor Grok 4.5 High Fast (same agent style Josh uses):",
    "• Ask questions, diagnose issues, or request a fix via PR",
    "• Or prefix with “ask cursor …”",
    "",
    "I still refuse purchases, deletion/purge, warmup/hold bypasses, fleet policy edits, bulk remediation, and direct production deploys.",
  );
  return lines.join("\n");
}
