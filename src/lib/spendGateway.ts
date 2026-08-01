import type { SlackClient } from "../clients/slack.js";
import {
  canBuyDomain,
  canCreateMailboxes,
} from "./monthlyCaps.js";
import type { SpendApprovalRecord, StateStore } from "../state/store.js";

export interface ClientSpendBudget {
  clientId: number | null;
  clientName: string;
  domainSpendUsd?: number;
  mailboxesCreated?: number;
  domainCapUsd: number;
  mailboxCap: number;
}

export interface SpendRequest {
  /** Stable id for this exact spend (reused as the InboxKit idempotency key). */
  key: string;
  /** Client spend must include cap metadata; other scopes are separately gated. */
  scope: "client" | "generic_pool" | "destructive";
  kind: string;
  description: string;
  detail?: Record<string, unknown>;
  /** Required for client-scoped spend; hard monthly caps are checked twice. */
  clientSpend?: ClientSpendBudget;
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
    const capFailure = this.checkClientCaps(req);
    if (capFailure) {
      const existingCap = this.state.getLatestSpendApprovalForRequest(req.key);
      if (
        existingCap?.status === "denied" &&
        existingCap.decidedBy === "monthly-cap" &&
        existingCap.description.endsWith(`BLOCKED: ${capFailure}`)
      ) {
        return { approved: false, record: existingCap };
      }
      const record: SpendApprovalRecord = {
        id: `${req.key}:cap:${Date.now()}`,
        requestKey: req.key,
        kind: req.kind,
        description: `${req.description} BLOCKED: ${capFailure}`,
        detail: req.detail ?? {},
        requestedAt: new Date().toISOString(),
        status: "denied",
        decidedAt: new Date().toISOString(),
        decidedBy: "monthly-cap",
      };
      this.state.upsertSpendApproval(record);
      await this.notifyCapBlocked(record, capFailure);
      await this.state.save();
      return { approved: false, record };
    }

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

    const existing =
      this.state.getLatestSpendApprovalForRequest(req.key) ??
      this.state.getSpendApproval(req.key);
    if (!existing) {
      return this.createPending(req, req.key);
    }

    if (existing.status === "consumed") {
      return this.createPending(req, `${req.key}:cycle:${Date.now()}`);
    }

    return { approved: existing.status === "approved", record: existing };
  }

  /**
   * Consume a one-time approval only after the external purchase succeeds.
   * Client usage is recorded in the same persisted state update.
   */
  async consume(
    decision: SpendDecision,
    req: SpendRequest,
  ): Promise<void> {
    if (this.enabled) {
      const consumed = this.state.consumeSpendApproval(decision.record.id);
      if (!consumed) {
        throw new Error(
          `Spend approval ${decision.record.id} was not approved or was already consumed`,
        );
      }
    }
    const budget = req.clientSpend;
    if (budget) {
      if ((budget.domainSpendUsd ?? 0) > 0) {
        this.state.recordDomainSpend(
          budget.clientId,
          budget.clientName,
          budget.domainSpendUsd!,
        );
      }
      if ((budget.mailboxesCreated ?? 0) > 0) {
        this.state.recordMailboxCreates(
          budget.clientId,
          budget.clientName,
          budget.mailboxesCreated!,
        );
      }
    }
    await this.state.save();
  }

  private checkClientCaps(req: SpendRequest): string | null {
    if (req.scope === "client" && !req.clientSpend) {
      return "client-scoped spend is missing mandatory monthly-cap metadata";
    }
    const budget = req.clientSpend;
    if (!budget) return null;
    const usage = this.state.getClientMonthlyUsage(
      budget.clientId,
      budget.clientName,
    );
    if ((budget.domainSpendUsd ?? 0) > 0) {
      const domain = canBuyDomain(
        usage,
        budget.domainSpendUsd!,
        budget.domainCapUsd,
      );
      if (!domain.ok) return domain.reason ?? "domain spend cap exceeded";
    }
    if ((budget.mailboxesCreated ?? 0) > 0) {
      const mailboxes = canCreateMailboxes(
        usage,
        budget.mailboxesCreated!,
        budget.mailboxCap,
      );
      if (!mailboxes.ok) {
        return mailboxes.reason ?? "mailbox creation cap exceeded";
      }
    }
    return null;
  }

  private async createPending(
    req: SpendRequest,
    id: string,
  ): Promise<SpendDecision> {
    const record: SpendApprovalRecord = {
      id,
      requestKey: req.key,
      kind: req.kind,
      description: req.description,
      detail: req.detail ?? {},
      requestedAt: new Date().toISOString(),
      status: "pending",
    };
    this.state.upsertSpendApproval(record);
    await this.state.save();
    await this.notifyPending(record);
    return { approved: false, record };
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

  private async notifyCapBlocked(
    record: SpendApprovalRecord,
    reason: string,
  ): Promise<void> {
    try {
      await this.slack.send(
        [
          `*Spend blocked by monthly cap* (${record.kind})`,
          record.description,
          reason,
          `This cannot be overridden by approving the request; wait for the next UTC month or change the owner-approved cap.`,
        ].join("\n"),
      );
    } catch (error) {
      console.error("[spend-gateway] cap Slack notify failed", error);
    }
  }
}
