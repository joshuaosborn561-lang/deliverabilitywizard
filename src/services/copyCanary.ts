import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  parseSenderInboxRates,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { sleep } from "../lib/http.js";
import {
  interpretCopyCanary,
  majorityLanded,
  type CopyCanarySplit,
} from "../lib/copyCanary.js";
import { isCopyCanaryFleetEmail } from "../lib/copyCanaryFleet.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import { isExcluded } from "./campaignTopUp.js";
import type { PoolMailboxRecord, StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface CopyCanaryAttachResult {
  dryRun: boolean;
  attached: Array<{ campaignId: number; email: string }>;
  skipped: string[];
  errors: string[];
  buyRequested: boolean;
}

/**
 * Keep the dedicated unwarmed canary fleet on each ACTIVE campaign so they
 * send the live sequence. Isolation reads that against warmed peers (D54).
 */
export class CopyCanaryService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async attach(opts: { dryRun?: boolean } = {}): Promise<CopyCanaryAttachResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CopyCanaryAttachResult = {
      dryRun,
      attached: [],
      skipped: [],
      errors: [],
      buyRequested: false,
    };
    if (!this.config.enableCopyCanary) {
      console.log("[copy-canary] Disabled");
      return result;
    }

    const fleet = this.state.getCopyCanaryFleet();
    const fleetEmails = fleet?.emails ?? [];
    if (!fleetEmails.length) {
      result.buyRequested = await this.requestFleetBuy();
      result.skipped.push("canary fleet not bought yet");
      await this.state.save();
      return result;
    }

    let campaigns: SmartleadCampaign[] = [];
    let accounts: SmartleadAccountWithCampaigns[] = [];
    try {
      [campaigns, accounts] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      return result;
    }

    const accountByEmail = new Map(
      accounts
        .map((account) => {
          const email = accountEmail(account)?.toLowerCase();
          return email ? ([email, account] as const) : null;
        })
        .filter((row): row is readonly [string, SmartleadAccountWithCampaigns] =>
          Boolean(row),
        ),
    );
    this.syncFleetAccountIds(accountByEmail);

    const picks = this.fleetReady(accountByEmail);
    if (!picks.length) {
      result.skipped.push("canary fleet not in Smartlead yet");
      await this.state.save();
      return result;
    }

    const active = campaigns.filter((campaign) => {
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE") return false;
      return !isExcluded(campaign, this.config.topUpExcludeCampaigns);
    });

    for (const campaign of active) {
      const current = this.liveCanariesOnCampaign(campaign.id, accountByEmail);
      const already = new Set(current);
      const kept = [...current];

      for (const pool of picks) {
        if (already.has(pool.email.toLowerCase())) continue;
        const accountId = pool.smartleadAccountId;
        if (!accountId) continue;
        try {
          if (!dryRun) {
            await this.smartlead.addEmailAccountsToCampaign(campaign.id, [
              accountId,
            ]);
            await sleep(250);
            await this.smartlead.updateEmailAccount(accountId, {
              signature: buildPoolSignature({
                firstName: pool.firstName || "Canary",
                lastName: pool.lastName || "Box",
                clientBrand: "Canary",
              }),
              from_name: `${pool.firstName || "Canary"} ${pool.lastName || "Box"}`,
              max_email_per_day: this.config.messagePerDay,
              time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
            });
            await this.smartlead.configureWarmup(accountId, {
              warmup_enabled: false,
              total_warmup_per_day: this.config.warmupTotalPerDay,
              daily_rampup: this.config.warmupDailyRampup,
              reply_rate_percentage: this.config.warmupReplyRatePercentage,
            });
            await sleep(150);
          }
          kept.push(pool.email.toLowerCase());
          result.attached.push({
            campaignId: campaign.id,
            email: pool.email.toLowerCase(),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`${pool.email} #${campaign.id}: ${message}`);
        }
      }
      this.state.setCopyCanaries(campaign.id, kept);
    }

    if (result.attached.length) {
      console.log(
        `[copy-canary] attached ${result.attached.length} dedicated canary mailbox(es) for campaign copy`,
      );
    }
    await this.state.save();
    return result;
  }

  async readSplit(campaignId: number): Promise<CopyCanarySplit | null> {
    if (!this.smartDelivery) return null;
    const canaries = new Set([
      ...this.state.getCopyCanaries(campaignId).map((email) => email.toLowerCase()),
      ...(this.state.getCopyCanaryFleet()?.emails ?? []).map((email) =>
        email.toLowerCase(),
      ),
    ]);
    if (!canaries.size) return null;

    try {
      const tests = await this.smartDelivery.listTests({}).catch(() => []);
      const mine = tests.filter(
        (test) => campaignIdOf(test) === String(campaignId),
      );
      const latest = mine.sort((a, b) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      )[0];
      const testId = latest ? testIdOf(latest) : undefined;
      if (!testId) return null;
      const raw = await this.smartDelivery.getSenderAccountReport(testId);
      const rows = parseSenderInboxRates(raw, testId, {
        preferSameEsp: true,
        minSameEspSamples: this.config.minSameEspSamples,
      });
      const threshold = this.config.remediationInboxThreshold;
      let unwarmedTested = 0;
      let unwarmedInbox = 0;
      let warmedTested = 0;
      let warmedInbox = 0;
      for (const row of rows) {
        if (!row.scoredSameEsp) continue;
        const landed = row.inboxRate >= threshold;
        if (canaries.has(row.email.toLowerCase())) {
          unwarmedTested += 1;
          if (landed) unwarmedInbox += 1;
        } else {
          warmedTested += 1;
          if (landed) warmedInbox += 1;
        }
      }
      return {
        unwarmedLanded: majorityLanded(unwarmedInbox, unwarmedTested),
        warmedLanded: majorityLanded(warmedInbox, warmedTested),
        unwarmedTested,
        warmedTested,
        unwarmedInbox,
        warmedInbox,
      };
    } catch {
      return null;
    }
  }

  describeSplit(split: CopyCanarySplit | null): string | undefined {
    if (!split) return undefined;
    const reading = interpretCopyCanary(split);
    if (reading.lean === "NONE") return undefined;
    return `Unwarmed campaign copy: ${split.unwarmedInbox}/${split.unwarmedTested} inbox. Warmed peers: ${split.warmedInbox}/${split.warmedTested}. ${reading.reason}`;
  }

  private liveCanariesOnCampaign(
    campaignId: number,
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>,
  ): string[] {
    const remembered = new Set([
      ...this.state.getCopyCanaries(campaignId),
      ...(this.state.getCopyCanaryFleet()?.emails ?? []),
    ]);
    const live: string[] = [];
    for (const email of remembered) {
      const account = accountByEmail.get(email);
      if (!account) continue;
      if (!campaignIdsOf(account).includes(campaignId)) continue;
      if (!this.stillUnwarmed(email)) continue;
      live.push(email);
    }
    return live;
  }

  private fleetReady(
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>,
  ): PoolMailboxRecord[] {
    const fleet = this.state.getCopyCanaryFleet();
    if (!fleet?.emails.length) return [];
    const out: PoolMailboxRecord[] = [];
    for (const email of fleet.emails) {
      const row = this.state.getPoolMailbox(email);
      const account = accountByEmail.get(email);
      const accountId = row?.smartleadAccountId ?? account?.id;
      if (!accountId) continue;
      if (row) {
        if (!row.smartleadAccountId) {
          this.state.upsertPoolMailbox({ ...row, smartleadAccountId: accountId });
        }
        out.push({ ...row, smartleadAccountId: accountId });
        continue;
      }
      if (!account) continue;
      const domain = email.split("@")[1] ?? "";
      const nameParts = (account.from_name || email.split("@")[0] || "Canary Box")
        .trim()
        .split(/\s+/);
      const created: PoolMailboxRecord = {
        email,
        domain,
        platform: poolEspFromSmartleadType(account.type) ?? "GOOGLE",
        smartleadAccountId: accountId,
        firstName: nameParts[0] || "Canary",
        lastName: nameParts.slice(1).join(" ") || "Box",
        status: "available",
        copyCanary: true,
      };
      this.state.upsertPoolMailbox(created);
      out.push(created);
    }
    return out;
  }

  private syncFleetAccountIds(
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>,
  ): void {
    const fleet = this.state.getCopyCanaryFleet();
    if (!fleet) return;
    for (const email of fleet.emails) {
      const account = accountByEmail.get(email);
      const row = this.state.getPoolMailbox(email);
      if (!account || !row || row.smartleadAccountId) continue;
      this.state.upsertPoolMailbox({ ...row, smartleadAccountId: account.id });
    }
  }

  private stillUnwarmed(email: string): boolean {
    return isCopyCanaryFleetEmail(email, this.state.getCopyCanaryFleet());
  }

  private async requestFleetBuy(): Promise<boolean> {
    const opened = await requestIsolationAction({
      store: this.state,
      slack: this.slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy the unwarmed canary fleet",
        proof:
          "Two new domains, three inboxes each — one Google, one Outlook. Warmup stays off. They send live campaign copy so we can tell copy from inboxes. They are not spare supply.",
        detail: {
          quantity: 2,
          mailboxesPerDomain: 3,
          parentDomain: this.config.isolationBuyParentDomain,
        },
      }),
    });
    if (!opened) return false;
    this.state.setCopyCanaryFleet({
      status: "pending",
      domains: [],
      emails: [],
      actionId: opened.id,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
}
