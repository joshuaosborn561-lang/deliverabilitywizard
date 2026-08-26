import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import { isClientInbox } from "../lib/clientInbox.js";
import { parseCampaignLeadStats } from "../lib/leadRunout.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { businessDate } from "./sendVolume.js";
import { isTerminalCampaignStatus } from "./campaignBounceAutostop.js";
import { overallSplit } from "./resultMonitor.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

/**
 * Per-client day brief for Slack (D39): sent / bounce% / spam%, plus how many
 * client inboxes are live vs held (pulled off campaigns). Replaces per-mailbox
 * Slack lists.
 */

export interface ClientDayRow {
  clientId: number | null;
  clientName: string;
  sent: number;
  bounced: number;
  bouncePercent: number | null;
  spamPercent: number | null;
  /** Client inboxes on-week and not held. */
  activeInboxes: number;
  /** Client inboxes currently held / pulled off campaigns. */
  heldInboxes: number;
  /** D41 — client inboxes in their off-week rest. */
  restingInboxes: number;
  /** Generics currently staffing this client (spare tire). */
  genericSpare: number;
}

export interface LoadedDraftRow {
  id: number;
  name: string;
  remaining: number;
}

export interface ClientDayBriefResult {
  date: string;
  totalSent: number;
  rows: ClientDayRow[];
  errors: string[];
  loadedDrafts?: LoadedDraftRow[];
}

function isDraftCampaignStatus(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "DRAFT" || s === "DRAFTED";
}

function toCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export class ClientDayBriefService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    options: { alert?: boolean; endOfDay?: boolean } = {},
  ): Promise<ClientDayBriefResult> {
    const date = businessDate();
    const errors: string[] = [];

    const [campaigns, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const clientNameById = new Map(
      clients.map((c) => [c.id, clientDisplayName(c)]),
    );

    type Agg = {
      clientId: number | null;
      clientName: string;
      sent: number;
      bounced: number;
      spamWeighted: number;
      spamWeight: number;
      campaignSent: Map<number, number>;
    };
    const byClient = new Map<string, Agg>();

    const active = campaigns.filter(
      (c) => String(c.status ?? "").toUpperCase() === "ACTIVE",
    );

    for (const campaign of active) {
      const clientId =
        typeof campaign.client_id === "number" ? campaign.client_id : null;
      const key =
        clientId != null
          ? `id:${clientId}`
          : `name:${String(campaign.name ?? campaign.id)}`;
      const clientName =
        clientId != null
          ? clientNameById.get(clientId) ?? `Client ${clientId}`
          : String(campaign.name ?? `campaign ${campaign.id}`);

      let agg = byClient.get(key);
      if (!agg) {
        agg = {
          clientId,
          clientName,
          sent: 0,
          bounced: 0,
          spamWeighted: 0,
          spamWeight: 0,
          campaignSent: new Map(),
        };
        byClient.set(key, agg);
      }

      try {
        const analytics = await this.smartlead.getCampaignAnalyticsByDate(
          campaign.id,
          date,
          date,
        );
        const sent = toCount(analytics?.sent_count);
        const bounced = toCount(analytics?.bounce_count);
        agg.sent += sent;
        agg.bounced += bounced;
        agg.campaignSent.set(campaign.id, sent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`#${campaign.id} ${campaign.name ?? ""}: ${message}`);
        agg.campaignSent.set(campaign.id, 0);
      }
      await sleep(250);
    }

    try {
      const tests = normalizeTestList(
        await this.smartDelivery.listTests({}).catch(() => []),
      );
      const latestByCampaign = new Map<string, string>();
      for (const test of tests) {
        const cid = campaignIdOf(test);
        const tid = testIdOf(test);
        if (!cid || !tid) continue;
        if (!latestByCampaign.has(cid)) latestByCampaign.set(cid, tid);
      }

      for (const agg of byClient.values()) {
        for (const [campaignId, campaignSent] of agg.campaignSent) {
          const testId = latestByCampaign.get(String(campaignId));
          if (!testId) continue;
          try {
            const rows = await this.smartDelivery.getProviderwiseReport(testId);
            const split = overallSplit(Array.isArray(rows) ? rows : []);
            if (!split) continue;
            const weight = Math.max(1, campaignSent);
            agg.spamWeighted += split.spamPercent * weight;
            agg.spamWeight += weight;
          } catch {
            // skip missing reports
          }
          await sleep(80);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`placement spam: ${message}`);
    }

    const heldByClient = new Map<number, number>();
    const activeByClient = new Map<number, number>();
    const restingByClient = new Map<number, number>();
    const genericByClient = new Map<number, number>();
    try {
      const accounts = (await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: false,
      })) as SmartleadAccountWithCampaigns[];
      for (const account of accounts) {
        const email = accountEmail(account);
        if (!email) continue;
        const clientId = account.client_id;
        if (typeof clientId !== "number" || !Number.isFinite(clientId)) continue;
        if (this.state.getHeldInbox(email)) {
          heldByClient.set(clientId, (heldByClient.get(clientId) ?? 0) + 1);
        } else if (this.state.getRestingInbox(email)) {
          restingByClient.set(
            clientId,
            (restingByClient.get(clientId) ?? 0) + 1,
          );
        } else if (!isClientInbox(account, email, this.config, this.state)) {
          genericByClient.set(
            clientId,
            (genericByClient.get(clientId) ?? 0) + 1,
          );
        } else {
          activeByClient.set(
            clientId,
            (activeByClient.get(clientId) ?? 0) + 1,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`inbox counts: ${message}`);
    }

    const rows: ClientDayRow[] = [...byClient.values()]
      .map((agg) => {
        const held =
          agg.clientId != null ? heldByClient.get(agg.clientId) ?? 0 : 0;
        const activeCount =
          agg.clientId != null ? activeByClient.get(agg.clientId) ?? 0 : 0;
        const resting =
          agg.clientId != null ? restingByClient.get(agg.clientId) ?? 0 : 0;
        const genericSpare =
          agg.clientId != null ? genericByClient.get(agg.clientId) ?? 0 : 0;
        return {
          clientId: agg.clientId,
          clientName: agg.clientName,
          sent: agg.sent,
          bounced: agg.bounced,
          bouncePercent:
            agg.sent > 0 ? (agg.bounced / agg.sent) * 100 : null,
          spamPercent:
            agg.spamWeight > 0 ? agg.spamWeighted / agg.spamWeight : null,
          activeInboxes: activeCount,
          heldInboxes: held,
          restingInboxes: resting,
          genericSpare,
        };
      })
      .sort((a, b) => b.sent - a.sent);

    const result: ClientDayBriefResult = {
      date,
      totalSent: rows.reduce((sum, r) => sum + r.sent, 0),
      rows,
      errors,
    };

    console.log(
      `[client-day] ${date}: ${result.totalSent} sent across ${rows.length} client(s)${errors.length ? `; ${errors.length} error(s)` : ""}`,
    );

    // D85 — untagged campaigns block signature QA and the tagger cannot
    // guess (D77). The EOD brief is their daily human surface.
    const untagged = campaigns
      .filter(
        (campaign) =>
          typeof campaign.client_id !== "number" &&
          !isPodControlShellCampaign(campaign) &&
          !isTerminalCampaignStatus(campaign.status),
      )
      .map((campaign) => ({
        id: campaign.id,
        name: String(campaign.name ?? campaign.id),
      }));

    const loadedDrafts = options.endOfDay
      ? await this.collectLoadedDrafts(campaigns, errors)
      : [];
    if (loadedDrafts.length) {
      result.loadedDrafts = loadedDrafts;
    }

    if (options.alert !== false) {
      await this.slack.notifyClientDayBrief({
        ...result,
        endOfDay: options.endOfDay === true,
        staffingShorts: options.endOfDay
          ? this.state.listLastStaffingShort()
          : undefined,
        untaggedCampaigns: options.endOfDay ? untagged : undefined,
        loadedDrafts: options.endOfDay ? loadedDrafts : undefined,
        canaryFleetDownSince: options.endOfDay
          ? this.state.getCanaryFleetDown()?.since ?? null
          : null,
      });
    }
    return result;
  }

  /**
   * D89 — DRAFT/DRAFTED campaigns that already have leads sitting in them
   * and are not sending. Named on the EOD brief only. Does not import
   * leads (D52) and does not START anyone (D40).
   */
  private async collectLoadedDrafts(
    campaigns: SmartleadCampaign[],
    errors: string[],
  ): Promise<LoadedDraftRow[]> {
    const drafts = campaigns.filter(
      (campaign) =>
        isDraftCampaignStatus(campaign.status) &&
        !isPodControlShellCampaign(campaign) &&
        !isTerminalCampaignStatus(campaign.status),
    );
    const loaded: LoadedDraftRow[] = [];
    for (const campaign of drafts) {
      try {
        let stats = parseCampaignLeadStats(
          await this.smartlead.getCampaignStatistics(campaign.id).catch(() => null),
        );
        if (!stats) {
          stats = parseCampaignLeadStats(
            await this.smartlead.getCampaign(campaign.id).catch(() => null),
          );
        }
        if (!stats || stats.remaining <= 0) continue;
        loaded.push({
          id: campaign.id,
          name: String(campaign.name ?? campaign.id),
          remaining: stats.remaining,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`draft #${campaign.id}: ${message}`);
      }
      await sleep(150);
    }
    return loaded;
  }
}
