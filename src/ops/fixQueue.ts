/**
 * One list for spend approvals, copy changes, isolation asks, and open
 * canon findings. Copy changes carry a SpamAssassin score. Approve is
 * allowed only when that score is 0.
 */

import type { OpsRole } from "./auth.js";
import { findingKind } from "../lib/canonCompliance.js";
import { canDecideIsolationAction } from "../lib/isolationActors.js";
import {
  campaignCheckIsActive,
  type CampaignCheckRecord,
} from "../lib/campaignCheck.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { OpsAuditRecord, SpendApprovalRecord } from "../state/store.js";
import {
  copyChangeText,
  scoreSpamAssassin,
  spamAssassinBlocksApproval,
  type SpamAssassinScore,
} from "./spamAssassin.js";

export type FixFilter = "all" | "approval" | "copy" | "isolation" | "audit";

export interface FixQueueItem {
  id: string;
  filter: Exclude<FixFilter, "all">;
  title: string;
  subtitle: string;
  clientName: string;
  spamAssassin: SpamAssassinScore | null;
  approveLabel: "Approve" | "Fix";
  approveDisabled: boolean;
  rejectLabel: "Reject";
}

export interface FixQueue {
  counts: Record<FixFilter, number>;
  items: FixQueueItem[];
}

const COPY_KINDS = new Set(["merge_tag_blank", "foreign_brand_in_copy"]);

function clientFromText(text: string): string {
  const head = text.split(/[|·:]/)[0]?.trim() ?? "";
  if (head.length >= 2 && head.length <= 40 && !head.includes("@")) return head;
  return "";
}

function rejectedIds(audit: OpsAuditRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const row of audit) {
    if (row.action === "finding-reject" && row.target) ids.add(row.target);
  }
  return ids;
}

export function buildFixQueue(input: {
  role: OpsRole;
  approvals: SpendApprovalRecord[];
  isolation: IsolationActionRecord[];
  checks: CampaignCheckRecord[];
  audit: OpsAuditRecord[];
  /** Live inventory status by campaign id; same ACTIVE filter as Today and /health. */
  statusById?: Map<number, string>;
}): FixQueue {
  const items: FixQueueItem[] = [];
  const hidden = rejectedIds(input.audit);

  for (const approval of input.approvals) {
    if (approval.status !== "pending") continue;
    if (input.role !== "owner") continue;
    items.push({
      id: `approval:${approval.id}`,
      filter: "approval",
      title: approval.description || approval.kind,
      subtitle: approval.kind,
      clientName: clientFromText(approval.description || ""),
      spamAssassin: null,
      approveLabel: "Approve",
      approveDisabled: false,
      rejectLabel: "Reject",
    });
  }

  for (const action of input.isolation) {
    if (action.status !== "pending") continue;
    const copy = action.kind === "swap_copy";
    const scored = copy
      ? scoreSpamAssassin(copyChangeText(action.detail))
      : null;
    const roleOk = canDecideIsolationAction(action.kind, input.role);
    const blocked = scored != null && spamAssassinBlocksApproval(scored.score);
    const clientName =
      clientFromText(String(action.detail.campaignName ?? "")) ||
      clientFromText(action.title);
    items.push({
      id: `${copy ? "copy" : "isolation"}:${action.id}`,
      filter: copy ? "copy" : "isolation",
      title: action.title,
      subtitle: copy
        ? clientName
          ? `${clientName} · suggested copy`
          : "suggested copy"
        : action.proof.slice(0, 180),
      clientName,
      spamAssassin: scored,
      approveLabel: "Approve",
      approveDisabled: !roleOk || blocked,
      rejectLabel: "Reject",
    });
  }

  for (const record of input.checks) {
    // Only living ACTIVE campaigns from the live book. Rows for paused,
    // drafted, or deleted campaigns are not re-judged every pass, so their
    // findings go stale; Today and /health already hide them.
    if (!campaignCheckIsActive(record, input.statusById)) continue;
    for (const finding of record.findings ?? []) {
      const kind = findingKind(finding);
      if (!COPY_KINDS.has(kind) && kind !== "mailbox_sig" && kind !== "missing_signature_tag" && kind !== "merge_tag_blank") {
        continue;
      }
      const id = `audit:${record.campaignId}:${kind}`;
      if (hidden.has(id)) continue;
      if (items.some((item) => item.id === id)) continue;
      const detail = finding.slice(kind.length + 1).trim();
      items.push({
        id,
        filter: "audit",
        title: detail || finding,
        subtitle: record.name,
        clientName: clientFromText(record.name),
        spamAssassin: null,
        approveLabel: "Fix",
        approveDisabled: false,
        rejectLabel: "Reject",
      });
    }
  }

  const counts: Record<FixFilter, number> = {
    all: items.length,
    approval: items.filter((item) => item.filter === "approval").length,
    copy: items.filter((item) => item.filter === "copy").length,
    isolation: items.filter((item) => item.filter === "isolation").length,
    audit: items.filter((item) => item.filter === "audit").length,
  };
  return { counts, items };
}
