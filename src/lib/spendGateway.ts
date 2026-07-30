import type { SlackClient } from "../clients/slack.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

export interface SpendRequest {
  /** Stable id for this exact spend (reused as the InboxKit idempotency key). */
  key: string;
  kind: string;
  description: string;
  detail?: Record<string, unknown>;
}

export interface SpendDecision {
  approved: boolean;
  record: SpendApprovalRecord;
}

/**
 * Blocks any real-money/credit spend until a human explicitly approves it via
 * POST /approvals/:id/approve. First time a spend key is seen it is recorded
 * as "pending" and Slack is notified; the caller must treat it as not
 * approved and skip the spend. Only a state record with status "approved"
 * (set only by that endpoint) authorizes the spend.
 */
export class SpendGateway {
  constructor(
    private readonly state: StateStore,
    private readonly slack: SlackClient,
    private readonly enabled: boolean,
  ) {}

  async authorize(req: SpendRequest): Promise<SpendDecision> {
    if (!this.enabled) {
      const record: SpendApprovalRecord = {
        id: req.key,
        kind: req.kind,
        description: req.description,
        detail: req.detail ?? {},
        requestedAt: new Date().toISOString(),
        status: "approved",
        decidedAt: new Date().toISOString(),
        decidedBy: "gateway-disabled",
      };
      return { approved: true, record };
    }

    const existing = this.state.getSpendApproval(req.key);
    if (!existing) {
      const record: SpendApprovalRecord = {
        id: req.key,
        kind: req.kind,
        description: req.description,
        detail: req.detail ?? {},
        requestedAt: new Date().toISOString(),
        status: "pending",
      };
      this.state.upsertSpendApproval(record);
      await this.notifyPending(record);
      return { approved: false, record };
    }

    return { approved: existing.status === "approved", record: existing };
  }

  private async notifyPending(record: SpendApprovalRecord): Promise<void> {
    try {
      await this.slack.send(
        [
          `*Spend approval needed* (${record.kind})`,
          record.description,
          `Approve: \`POST /approvals/${encodeURIComponent(record.id)}/approve\``,
          `Deny: \`POST /approvals/${encodeURIComponent(record.id)}/deny\``,
          `(Send \`X-Run-Token\` header if RUN_TOKEN is set. No spend happens until approved.)`,
        ].join("\n"),
      );
    } catch (error) {
      console.error("[spend-gateway] Slack notify failed", error);
    }
  }
}
