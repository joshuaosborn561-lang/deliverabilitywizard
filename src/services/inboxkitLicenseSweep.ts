/**
 * D222 / D226 / D245 — weekday 8:16am CT InboxKit lapsed-license sweep.
 * Findings go to Onboarding and Deliverability through state / /health.
 * Lapsed seats are deleted from Smartlead and InboxKit. Slack is only
 * the post-cleanup one-liner when X > 0.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import {
  clientDisplayName,
  type SmartleadClient,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { sleep } from "../lib/http.js";
import {
  buildInboxkitSeatEnds,
  chicagoYmd,
  classifyInboxkitLicenseSweep,
  formatInboxkitLicenseCleanupSlack,
  groupInboxkitLicenseHandoff,
  inboxkitLicenseIdleReason,
  type InboxkitLicenseFinding,
  type InboxkitLicenseHandoff,
  type InboxkitLicenseMailbox,
} from "../lib/inboxkitLicense.js";
import type { StateStore } from "../state/store.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export interface InboxkitLicenseSweepResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  examinedInboxkit: number;
  examinedSmartlead: number;
  findings: InboxkitLicenseFinding[];
  deleted: number;
  posted: boolean;
  errors: string[];
}

export class InboxkitLicenseSweepService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      "listAllEmailAccounts" | "listClients" | "deleteEmailAccount"
    >,
    private readonly inboxkit: Pick<
      InboxKitClient,
      "listWorkspaces" | "listAllMailboxes" | "cancelMailboxes"
    > | null,
    private readonly slack: Pick<SlackClient, "notifyDeliverabilityNote">,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; now?: Date; force?: boolean } = {},
  ): Promise<InboxkitLicenseSweepResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: InboxkitLicenseSweepResult = {
      dryRun,
      examinedInboxkit: 0,
      examinedSmartlead: 0,
      findings: [],
      deleted: 0,
      posted: false,
      errors: [],
    };
    if (!this.config.enableInboxkitLicenseSweep) {
      return { ...result, skipped: true, reason: "disabled" };
    }
    if (!this.inboxkit) {
      return { ...result, skipped: true, reason: "inboxkit not configured" };
    }
    if (!opts.force) {
      const idle = inboxkitLicenseIdleReason(now);
      if (idle) return { ...result, skipped: true, reason: idle };
    }

    try {
      const [mailboxes, accounts, clients] = await Promise.all([
        this.listInboxkitMailboxes(),
        this.smartlead.listAllEmailAccounts(),
        this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      ]);
      result.examinedInboxkit = mailboxes.length;
      result.examinedSmartlead = accounts.length;
      const clientNameById = new Map(
        clients.map((client) => [client.id, clientDisplayName(client)]),
      );
      // D245: persist every lapsed / scheduled-cancel seat with its date so
      // staffing never attaches a seat that is lapsed or ends within 7 days.
      this.state.setInboxkitSeatEnds(buildInboxkitSeatEnds(mailboxes));
      result.findings = classifyInboxkitLicenseSweep({
        mailboxes,
        accounts,
        clientNameById,
        now,
      });

      const deletedEmails: string[] = [];
      if (!dryRun) {
        for (const finding of result.findings) {
          if (finding.kind !== "still_connected") continue;
          const ok = await this.deleteLapsed(finding, result);
          if (ok) deletedEmails.push(finding.email);
        }
      }
      result.deleted = deletedEmails.length;

      const handoff: InboxkitLicenseHandoff = {
        at: now.toISOString(),
        ymd: chicagoYmd(now),
        deleted: result.deleted,
        deletedEmails,
        clients: groupInboxkitLicenseHandoff(result.findings),
      };
      this.state.setInboxkitLicenseHandoff(handoff);
      this.state.appendOpsAudit({
        id: randomUUID(),
        at: handoff.at,
        actor: "inboxkit-license",
        role: "owner",
        action: "inboxkit-license-handoff",
        outcome: "success",
        detail: `clients=${handoff.clients.length} still=${result.findings.filter((row) => row.kind === "still_connected").length} upcoming=${result.findings.filter((row) => row.kind === "scheduled_cancel").length} deleted=${result.deleted}`,
      });
      if (!dryRun) await this.state.save();

      const text = formatInboxkitLicenseCleanupSlack(result.deleted);
      if (text && !dryRun) {
        await this.slack.notifyDeliverabilityNote(text);
        result.posted = true;
      }
      console.log(
        `[inboxkit-license] examined_ik=${result.examinedInboxkit} examined_sl=${result.examinedSmartlead} findings=${result.findings.length} deleted=${result.deleted} posted=${result.posted}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      console.warn(`[inboxkit-license] failed: ${message}`);
      throw error;
    }
  }

  private async deleteLapsed(
    finding: InboxkitLicenseFinding,
    result: InboxkitLicenseSweepResult,
  ): Promise<boolean> {
    let deleted = false;
    try {
      if (finding.slAccountId != null) {
        await this.smartlead.deleteEmailAccount(finding.slAccountId);
        deleted = true;
        await sleep(WRITE_GAP_MS);
      }
      if (finding.inboxkitUid && this.inboxkit) {
        await this.inboxkit.cancelMailboxes([finding.inboxkitUid], {
          workspaceId: finding.workspaceId ?? undefined,
        });
        deleted = true;
        await sleep(WRITE_GAP_MS);
      }
      if (!deleted) {
        result.errors.push(`${finding.email}: no Smartlead id or InboxKit uid`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${finding.email}: ${message}`);
      return false;
    }
    return deleted;
  }

  private async listInboxkitMailboxes(): Promise<InboxkitLicenseMailbox[]> {
    if (!this.inboxkit) return [];
    const workspaces = await this.inboxkit.listWorkspaces().catch(() => []);
    const seen = new Set<string>();
    const out: InboxkitLicenseMailbox[] = [];
    for (const ws of workspaces) {
      const id = ws.uid || ws.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // D245: InboxKit caps a page at 100 rows; asking for 200 made the
      // pager stop after page 1 (100 < 200) and miss the rest.
      const rows = await this.inboxkit.listAllMailboxes(id, 100);
      out.push(
        ...rows.map((row) => ({
          ...row,
          workspaceId: id,
        })),
      );
    }
    if (!out.length) {
      out.push(...(await this.inboxkit.listAllMailboxes(undefined, 100)));
    }
    return out;
  }
}
