/**
 * D222 — weekly Monday 8:16am CT InboxKit lapsed-license sweep.
 * Detection only. Posts per-client findings to #deliverability.
 */

import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import {
  clientDisplayName,
  type SmartleadClient,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import {
  classifyInboxkitLicenseSweep,
  formatInboxkitLicenseSlack,
  inboxkitLicenseIdleReason,
  type InboxkitLicenseFinding,
} from "../lib/inboxkitLicense.js";

export interface InboxkitLicenseSweepResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  examinedInboxkit: number;
  examinedSmartlead: number;
  findings: InboxkitLicenseFinding[];
  posted: boolean;
  errors: string[];
}

export class InboxkitLicenseSweepService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      "listAllEmailAccounts" | "listClients"
    >,
    private readonly inboxkit: Pick<
      InboxKitClient,
      "listWorkspaces" | "listAllMailboxes"
    > | null,
    private readonly slack: Pick<SlackClient, "notifyDeliverabilityNote">,
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
      result.findings = classifyInboxkitLicenseSweep({
        mailboxes,
        accounts,
        clientNameById,
        now,
      });
      const text = formatInboxkitLicenseSlack(result.findings);
      if (text && !dryRun) {
        await this.slack.notifyDeliverabilityNote(text);
        result.posted = true;
      }
      console.log(
        `[inboxkit-license] examined_ik=${result.examinedInboxkit} examined_sl=${result.examinedSmartlead} findings=${result.findings.length} posted=${result.posted}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      console.warn(`[inboxkit-license] failed: ${message}`);
      throw error;
    }
  }

  private async listInboxkitMailboxes() {
    if (!this.inboxkit) return [];
    const workspaces = await this.inboxkit.listWorkspaces().catch(() => []);
    const seen = new Set<string>();
    const out = [];
    for (const ws of workspaces) {
      const id = ws.uid || ws.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rows = await this.inboxkit.listAllMailboxes(id);
      out.push(...rows);
    }
    if (!out.length) {
      out.push(...(await this.inboxkit.listAllMailboxes()));
    }
    return out;
  }
}
