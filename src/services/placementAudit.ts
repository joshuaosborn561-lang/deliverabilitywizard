import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import { parseSenderBounceStats } from "../lib/bounceRate.js";
import { isPrewarmedGeneric } from "./warmupGate.js";
import type { StateStore } from "../state/store.js";

export type PlacementDriftKind =
  | "missing_spam_assassin"
  | "link_checker_off"
  | "wrong_every_days"
  | "over_max_senders"
  | "missing_provider_ids"
  | "campaign_inactive"
  | "missing_campaign"
  | "esp_skew"
  | "detail_error";

export interface PlacementDrift {
  testId: string;
  testName?: string;
  campaignId?: string;
  campaignName?: string;
  kind: PlacementDriftKind;
  detail: string;
}

export interface PlacementAuditResult {
  checked: number;
  ok: number;
  drift: PlacementDrift[];
  untestedActiveCampaigns: Array<{ id: string; name: string }>;
  errors: string[];
}

export interface SendAuditRow {
  email: string;
  campaignIds: number[];
  sent: number;
  cap: number;
  hitCap: boolean;
  source: "daily_sent_count" | "health_metrics" | "unknown";
}

export interface SendAuditResult {
  date: string;
  cap: number;
  sendingMailboxes: number;
  hitCap: number;
  underCap: number;
  unknown: number;
  underCapSample: SendAuditRow[];
  errors: string[];
}

export interface BcpGenericHit {
  campaignId: number;
  campaignName: string;
  email: string;
  reason: "pool" | "prewarmed_domain" | "prewarmed_name" | "active_swap";
}

export interface BcpAuditResult {
  bcpCampaigns: Array<{ id: number; name: string; senders: number }>;
  genericHits: BcpGenericHit[];
  activeSwapsOnBcp: number;
  errors: string[];
}

export interface DayAuditResult {
  placements: PlacementAuditResult;
  sends: SendAuditResult;
  bcp: BcpAuditResult;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function senderRowsFromDetails(
  details: Record<string, unknown>,
): Array<{ email: string; type: string }> {
  const accounts = details.sender_accounts ?? details.senders ?? details.emails;
  if (!Array.isArray(accounts)) return [];
  const out: Array<{ email: string; type: string }> = [];
  for (const row of accounts) {
    if (typeof row === "string" && row.includes("@")) {
      out.push({ email: row.toLowerCase(), type: "" });
      continue;
    }
    if (row && typeof row === "object") {
      const obj = row as Record<string, unknown>;
      const email = String(
        obj.from_email ?? obj.email ?? obj.username ?? "",
      ).toLowerCase();
      if (!email.includes("@")) continue;
      out.push({ email, type: String(obj.type ?? obj.esp ?? "") });
    }
  }
  return out;
}

function espBucket(email: string, type: string): "gmail" | "outlook" | "other" {
  const t = type.toUpperCase();
  if (t.includes("GMAIL") || t.includes("GOOGLE")) return "gmail";
  if (t.includes("OUTLOOK") || t.includes("MICROSOFT") || t.includes("AZURE")) {
    return "outlook";
  }
  const domain = email.split("@")[1] ?? "";
  if (/^(gmail|googlemail)\.com$/i.test(domain)) return "gmail";
  if (/^(outlook|hotmail|live|msn)\./i.test(domain)) return "outlook";
  return "other";
}

function isBcpCampaignName(name: string): boolean {
  return /\bbcp\b/i.test(name) || /bolder\s*cyper/i.test(name);
}

/**
 * Read-only audits: placement-test contract drift, daily send caps, and BCP
 * generic contamination. Never spends, stops, or recreates.
 */
export class PlacementAuditService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async runPlacements(): Promise<PlacementAuditResult> {
    const result: PlacementAuditResult = {
      checked: 0,
      ok: 0,
      drift: [],
      untestedActiveCampaigns: [],
      errors: [],
    };

    let tests;
    try {
      const listed = normalizeTestList(await this.smartDelivery.listTests({}));
      tests = await this.smartDelivery.enrichCampaignIds(listed);
    } catch (error) {
      result.errors.push(
        `list tests: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    let campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>> = [];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      result.errors.push(
        `list campaigns: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const campaignById = new Map(
      campaigns.map((c) => [String(c.id), c] as const),
    );
    const activeStatuses = new Set(this.config.autoTestActiveStatuses);
    const covered = new Set<string>();

    for (const test of tests) {
      if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
      const testId = testIdOf(test);
      if (!testId) continue;
      result.checked += 1;

      const campaignId = campaignIdOf(test);
      if (campaignId) covered.add(campaignId);

      let details: Record<string, unknown>;
      try {
        details = await this.smartDelivery.getTestDetails(testId);
        await sleep(200);
      } catch (error) {
        result.drift.push({
          testId,
          testName: test.test_name,
          campaignId,
          kind: "detail_error",
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const before = result.drift.length;
      this.checkDetails(result, testId, test.test_name, campaignId, details);

      if (campaignId) {
        const campaign = campaignById.get(campaignId);
        if (!campaign) {
          result.drift.push({
            testId,
            testName: test.test_name,
            campaignId,
            kind: "missing_campaign",
            detail: "Campaign not found in Smartlead",
          });
        } else if (
          !activeStatuses.has(String(campaign.status ?? "").toUpperCase())
        ) {
          result.drift.push({
            testId,
            testName: test.test_name,
            campaignId,
            campaignName: campaign.name,
            kind: "campaign_inactive",
            detail: `Campaign status is ${campaign.status} — reconciler should stop this test`,
          });
        }
      }

      if (result.drift.length === before) result.ok += 1;
    }

    for (const campaign of campaigns) {
      if (!activeStatuses.has(String(campaign.status ?? "").toUpperCase())) {
        continue;
      }
      const id = String(campaign.id);
      if (!covered.has(id)) {
        result.untestedActiveCampaigns.push({
          id,
          name: String(campaign.name ?? `campaign ${id}`),
        });
      }
    }

    console.log("[placement-audit] Done", {
      checked: result.checked,
      ok: result.ok,
      drift: result.drift.length,
      untested: result.untestedActiveCampaigns.length,
      errors: result.errors.length,
    });

    if (
      result.drift.length ||
      result.untestedActiveCampaigns.length ||
      result.errors.length
    ) {
      await this.slack
        .send(
          [
            `*Placement test audit*`,
            `Checked ${result.checked} ACTIVE auto test(s): ${result.ok} ok, ${result.drift.length} drift.`,
            result.untestedActiveCampaigns.length
              ? `${result.untestedActiveCampaigns.length} ACTIVE campaign(s) have no living auto test.`
              : undefined,
            ...result.drift.slice(0, 15).map(
              (d) =>
                `• \`${d.testId}\` ${d.kind}: ${d.detail}${d.campaignId ? ` (campaign ${d.campaignId})` : ""}`,
            ),
            ...result.untestedActiveCampaigns
              .slice(0, 10)
              .map((c) => `• NO-TEST #${c.id} ${c.name}`),
            ...result.errors.slice(0, 5).map((e) => `• error: ${e}`),
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .catch((error) => {
          console.error("[placement-audit] Slack notify failed", error);
        });
    }

    return result;
  }

  private checkDetails(
    result: PlacementAuditResult,
    testId: string,
    testName: string | undefined,
    campaignId: string | undefined,
    details: Record<string, unknown>,
  ): void {
    const filters = asStringArray(details.spam_filters).map((s) =>
      s.toLowerCase(),
    );
    if (!filters.some((f) => f.includes("spam_assassin"))) {
      result.drift.push({
        testId,
        testName,
        campaignId,
        kind: "missing_spam_assassin",
        detail: `spam_filters=${JSON.stringify(details.spam_filters ?? null)}`,
      });
    }

    if (details.link_checker !== true && details.link_checker !== "true") {
      result.drift.push({
        testId,
        testName,
        campaignId,
        kind: "link_checker_off",
        detail: `link_checker=${String(details.link_checker)}`,
      });
    }

    const everyDays = Number(details.every_days ?? 0);
    if (
      Number.isFinite(everyDays) &&
      everyDays > 0 &&
      everyDays !== this.config.placementTestEveryDays
    ) {
      result.drift.push({
        testId,
        testName,
        campaignId,
        kind: "wrong_every_days",
        detail: `every_days=${everyDays}, expected ${this.config.placementTestEveryDays}`,
      });
    }

    const senders = senderRowsFromDetails(details);
    if (senders.length > this.config.maxMailboxesPerTest) {
      result.drift.push({
        testId,
        testName,
        campaignId,
        kind: "over_max_senders",
        detail: `${senders.length} senders > max ${this.config.maxMailboxesPerTest}`,
      });
    }

    if (
      Array.isArray(details.provider_ids) &&
      details.provider_ids.length === 0
    ) {
      result.drift.push({
        testId,
        testName,
        campaignId,
        kind: "missing_provider_ids",
        detail: "provider_ids is an empty array",
      });
    }

    if (senders.length >= 10) {
      let gmail = 0;
      let outlook = 0;
      for (const row of senders) {
        const bucket = espBucket(row.email, row.type);
        if (bucket === "gmail") gmail += 1;
        else if (bucket === "outlook") outlook += 1;
      }
      const known = gmail + outlook;
      if (known >= 10) {
        const minority = Math.min(gmail, outlook);
        const ratio = minority / known;
        // Pre-interleave batches often land ~6% Gmail. Flag extreme skew only.
        if (ratio < 0.15) {
          result.drift.push({
            testId,
            testName,
            campaignId,
            kind: "esp_skew",
            detail: `sender mix Gmail ${gmail} / Outlook ${outlook} (minority ${(ratio * 100).toFixed(0)}%)`,
          });
        }
      }
    }
  }

  async runSends(date = new Date().toISOString().slice(0, 10)): Promise<SendAuditResult> {
    const result: SendAuditResult = {
      date,
      cap: this.config.messagePerDay,
      sendingMailboxes: 0,
      hitCap: 0,
      underCap: 0,
      unknown: 0,
      underCapSample: [],
      errors: [],
    };

    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: true,
      });
    } catch (error) {
      result.errors.push(
        `list accounts: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    const campaigns = await this.smartlead.listCampaigns().catch(() => []);
    const activeIds = new Set(
      campaigns
        .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
        .map((c) => c.id),
    );

    const sending = accounts.filter((account) => {
      if (!accountEmail(account)) return false;
      return campaignIdsOf(account).some((id) => activeIds.has(id));
    });
    result.sendingMailboxes = sending.length;

    const sentByEmail = new Map<string, number>();
    let healthSource = false;
    try {
      const metrics = await this.smartlead.getMailboxHealthMetrics({
        startDate: date,
        endDate: date,
        fullData: true,
      });
      for (const row of parseSenderBounceStats(metrics)) {
        sentByEmail.set(row.email, row.sent);
      }
      healthSource = sentByEmail.size > 0;
    } catch (error) {
      result.errors.push(
        `health metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const account of sending) {
      const email = accountEmail(account)!.toLowerCase();
      const cap =
        typeof account.max_email_per_day === "number" &&
        account.max_email_per_day > 0
          ? account.max_email_per_day
          : this.config.messagePerDay;

      let sent: number | null = null;
      let source: SendAuditRow["source"] = "unknown";
      if (
        typeof account.daily_sent_count === "number" &&
        Number.isFinite(account.daily_sent_count)
      ) {
        sent = account.daily_sent_count;
        source = "daily_sent_count";
      } else if (healthSource && sentByEmail.has(email)) {
        sent = sentByEmail.get(email) ?? 0;
        source = "health_metrics";
      }

      if (sent === null) {
        result.unknown += 1;
        continue;
      }

      const row: SendAuditRow = {
        email,
        campaignIds: campaignIdsOf(account).filter((id) => activeIds.has(id)),
        sent,
        cap,
        hitCap: sent >= cap,
        source,
      };
      if (row.hitCap) result.hitCap += 1;
      else {
        result.underCap += 1;
        if (result.underCapSample.length < 40) result.underCapSample.push(row);
      }
    }

    result.underCapSample.sort((a, b) => a.sent - b.sent);

    console.log("[send-audit] Done", {
      date: result.date,
      sending: result.sendingMailboxes,
      hitCap: result.hitCap,
      underCap: result.underCap,
      unknown: result.unknown,
    });

    return result;
  }

  async runBcpGenerics(): Promise<BcpAuditResult> {
    const result: BcpAuditResult = {
      bcpCampaigns: [],
      genericHits: [],
      activeSwapsOnBcp: 0,
      errors: [],
    };

    let campaigns;
    let accounts: SmartleadAccountWithCampaigns[];
    try {
      [campaigns, accounts] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      ]);
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      return result;
    }

    const bcp = campaigns.filter(
      (c) =>
        String(c.status ?? "").toUpperCase() === "ACTIVE" &&
        isBcpCampaignName(String(c.name ?? "")),
    );
    const bcpIds = new Set(bcp.map((c) => c.id));

    const sendersByCampaign = new Map<number, number>();
    for (const account of accounts) {
      for (const id of campaignIdsOf(account)) {
        if (!bcpIds.has(id)) continue;
        sendersByCampaign.set(id, (sendersByCampaign.get(id) ?? 0) + 1);
      }
    }

    result.bcpCampaigns = bcp.map((c) => ({
      id: c.id,
      name: String(c.name ?? `campaign ${c.id}`),
      senders: sendersByCampaign.get(c.id) ?? 0,
    }));

    for (const swap of this.state.listActiveSwaps()) {
      const onBcp = swap.campaignIds.filter((id) => bcpIds.has(id));
      if (!onBcp.length) continue;
      result.activeSwapsOnBcp += 1;
      for (const campaignId of onBcp) {
        const campaign = bcp.find((c) => c.id === campaignId);
        result.genericHits.push({
          campaignId,
          campaignName: campaign?.name ?? `campaign ${campaignId}`,
          email: swap.poolEmail,
          reason: "active_swap",
        });
      }
    }

    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email) continue;
      const onBcp = campaignIdsOf(account).filter((id) => bcpIds.has(id));
      if (!onBcp.length) continue;

      const pool = this.state.getPoolMailbox(email);
      let reason: BcpGenericHit["reason"] | null = null;
      if (pool) reason = "pool";
      else if (isPrewarmedGeneric(account, email, this.config, this.state)) {
        const domain = email.split("@")[1] ?? "";
        reason = this.config.extraGenericDomains.includes(domain)
          ? "prewarmed_domain"
          : "prewarmed_name";
      }
      if (!reason) continue;

      for (const campaignId of onBcp) {
        const campaign = bcp.find((c) => c.id === campaignId);
        result.genericHits.push({
          campaignId,
          campaignName: campaign?.name ?? `campaign ${campaignId}`,
          email,
          reason,
        });
      }
    }

    console.log("[bcp-audit] Done", {
      campaigns: result.bcpCampaigns.length,
      genericHits: result.genericHits.length,
      activeSwapsOnBcp: result.activeSwapsOnBcp,
    });

    return result;
  }

  async runDay(): Promise<DayAuditResult> {
    const placements = await this.runPlacements();
    const sends = await this.runSends();
    const bcp = await this.runBcpGenerics();
    return { placements, sends, bcp };
  }
}

export { isBcpCampaignName };
