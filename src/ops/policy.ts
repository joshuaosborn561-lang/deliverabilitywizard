import type { OpsRole } from "./auth.js";

export type OpsIntent =
  | { type: "help" }
  | { type: "status" }
  | { type: "deliverability" }
  | { type: "dns" }
  | { type: "campaigns" }
  | { type: "reconnect" }
  | { type: "rotate"; email: string }
  | { type: "approvals" }
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

  const rotateEmail = message.match(EMAIL)?.[0]?.toLowerCase();
  if (rotateEmail && /\b(rotate|bench|swap|pull)\b/i.test(message)) {
    return { type: "rotate", email: rotateEmail };
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
        "Safety gates cannot be bypassed from the operations console: 14-day warmup/holds and spend approval are owner decisions (D1, D4, D6).",
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
        "The console cannot change fleet policy. Campaign floor 50 and mailbox cap 30/day are owner decisions and require a reviewed code/config change (D7, D11, D17).",
    };
  }

  if (/\b(deploy|merge|commit|push|edit code|shell|terminal)\b/i.test(message)) {
    return {
      type: "denied",
      reason:
        "Code and deployment are not operations-console capabilities. Use a task branch and reviewed pull request; production deploys from main.",
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
  if (/\b(campaigns?|sender count|headcount|coverage)\b/i.test(message)) {
    return { type: "campaigns" };
  }
  if (/\b(deliverability|placement|inbox|blacklist|check now)\b/i.test(message)) {
    return { type: "deliverability" };
  }
  if (/\b(status|summary|dashboard|how are things)\b/i.test(message)) {
    return { type: "status" };
  }
  return { type: "unknown" };
}

export function opsHelp(role: OpsRole): string {
  const lines = [
    "I can run allowlisted deliverability operations:",
    "• “Check deliverability” — placement results plus campaign and DNS audits",
    "• “Check DNS” — SPF/DMARC/MX audit without changing DNS",
    "• “Audit campaigns” — sender floor and placement-test coverage",
    "• “Reconnect disconnected mailboxes”",
    "• “Rotate name@example.com” — preview first, then explicit confirmation",
    "• “Status” — pool, holds, swaps and recent runs",
  ];
  if (role === "owner") {
    lines.push("• “Approvals” — owner-only pending spend decisions");
  }
  lines.push(
    "",
    "I will refuse purchases, deletion/purge, policy changes, warmup bypasses, bulk remediation, code changes and deployments, and explain the governing rule.",
  );
  return lines.join("\n");
}
