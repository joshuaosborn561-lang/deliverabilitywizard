import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  parseSenderInboxRates,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import {
  interpretCopyCanary,
  majorityLanded,
  type CopyCanarySplit,
} from "../lib/copyCanary.js";
import { buildPoolSignature } from "../lib/poolSignature.js";
import { daysSince, isPrewarmedGeneric } from "./warmupGate.js";
import { isExcluded } from "./campaignTopUp.js";
import type { PoolMailboxRecord, StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface CopyCanaryAttachResult {
  dryRun: boolean;
  attached: Array<{ campaignId: number; email: string }>;
  skipped: string[];
  errors: string[];
}

/**
 * Keep a few still-warming pool generics on each ACTIVE campaign so they
 * send the live sequence. Isolation reads that against warmed peers (D51).
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
    };
    const want = this.config.copyCanaryPerCampaign;
    if (!this.config.enableCopyCanary || want <= 0) {
      console.log("[copy-canary] Disabled");
      return result;
    }

    let campaigns: SmartleadCampaign[] = [];
    let accounts: SmartleadAccountWithCampaigns[] = [];
    let clients: SmartleadClientRecord[] = [];
    try {
      [campaigns, accounts, clients] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
        this.smartlead.listClients().catch(() => []),
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
    const clientsById = new Map(clients.map((row) => [row.id, row]));
    const reserved = new Set(
      this.state.listActiveSwaps().map((swap) => swap.poolEmail.toLowerCase()),
    );
    const usedThisRun = new Set<string>();

    const active = campaigns.filter((campaign) => {
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE") return false;
      return !isExcluded(campaign, this.config.topUpExcludeCampaigns);
    });

    for (const campaign of active) {
      const current = this.liveCanariesOnCampaign(campaign.id, accountByEmail);
      const need = Math.max(0, want - current.length);
      if (need === 0) {
        this.state.setCopyCanaries(campaign.id, current);
        continue;
      }

      const clientId =
        typeof campaign.client_id === "number" ? campaign.client_id : null;
      const picks = this.pickCanaries({
        need,
        campaign,
        accountByEmail,
        reserved,
        usedThisRun,
      });
      if (!picks.length) {
        result.skipped.push(`#${campaign.id}: no unwarmed pool supply`);
        this.state.setCopyCanaries(campaign.id, current);
        continue;
      }

      const clientName = clientId
        ? clientDisplayName(clientsById.get(clientId) ?? { id: clientId })
        : "Unassigned / Agency";
      const brand =
        clientName.replace(/\s*\(.*?\)\s*$/, "").trim() || clientName;
      const kept = [...current];

      for (const pool of picks) {
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
                firstName: pool.firstName || "Pool",
                lastName: pool.lastName || "User",
                clientBrand: brand,
              }),
              from_name: `${pool.firstName || "Pool"} ${pool.lastName || "User"}`,
              client_id: clientId,
              max_email_per_day: this.config.messagePerDay,
              time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
            });
            await sleep(150);
          }
          kept.push(pool.email.toLowerCase());
          usedThisRun.add(pool.email.toLowerCase());
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
        `[copy-canary] attached ${result.attached.length} unwarmed mailbox(es) for campaign copy`,
      );
    }
    return result;
  }

  async readSplit(campaignId: number): Promise<CopyCanarySplit | null> {
    if (!this.smartDelivery) return null;
    const canaries = new Set(
      this.state.getCopyCanaries(campaignId).map((email) => email.toLowerCase()),
    );
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
    const remembered = this.state.getCopyCanaries(campaignId);
    const live: string[] = [];
    for (const email of remembered) {
      const account = accountByEmail.get(email);
      if (!account) continue;
      if (!campaignIdsOf(account).includes(campaignId)) continue;
      if (!this.stillUnwarmed(email, account)) continue;
      live.push(email);
    }
    return live;
  }

  private pickCanaries(input: {
    need: number;
    campaign: SmartleadCampaign;
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>;
    reserved: Set<string>;
    usedThisRun: Set<string>;
  }): PoolMailboxRecord[] {
    const clientId =
      typeof input.campaign.client_id === "number"
        ? input.campaign.client_id
        : null;
    const alreadyOn = new Set(
      [...input.accountByEmail.values()]
        .filter((account) => campaignIdsOf(account).includes(input.campaign.id))
        .map((account) => accountEmail(account)?.toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );

    const scored = this.state
      .listPoolMailboxes()
      .filter((row) => this.isCandidate(row, input.reserved))
      .map((row) => {
        const account = input.accountByEmail.get(row.email.toLowerCase());
        const on = account ? campaignIdsOf(account) : [];
        const sameClient = on.some((id) => {
          // Prefer boxes already sending for this client.
          return id !== input.campaign.id;
        });
        const otherClient = Boolean(
          account &&
            clientId != null &&
            account.client_id != null &&
            account.client_id !== clientId &&
            on.length,
        );
        return { row, account, sameClient, otherClient };
      })
      .filter((row) => !row.otherClient)
      .filter((row) => !alreadyOn.has(row.row.email.toLowerCase()))
      .filter((row) => !input.usedThisRun.has(row.row.email.toLowerCase()))
      .sort((a, b) => Number(b.sameClient) - Number(a.sameClient));

    return scored.slice(0, input.need).map((row) => row.row);
  }

  private isCandidate(
    row: PoolMailboxRecord,
    reserved: Set<string>,
  ): boolean {
    if (row.status !== "warming") return false;
    if (row.prewarmed) return false;
    if (!row.smartleadAccountId) return false;
    if (!row.warmedAt) return false;
    const email = row.email.toLowerCase();
    if (reserved.has(email)) return false;
    if (this.state.getRestingInbox(email)) return false;
    if (this.state.getHeldInbox(email)) return false;
    if (
      isPrewarmedGeneric(
        { from_name: `${row.firstName} ${row.lastName}` },
        email,
        this.config,
        this.state,
      )
    ) {
      return false;
    }
    const days = daysSince(row.warmedAt);
    return Number.isFinite(days) && days < this.config.poolWarmupDays;
  }

  private stillUnwarmed(
    email: string,
    account: SmartleadAccountWithCampaigns,
  ): boolean {
    if (
      isPrewarmedGeneric(account, email, this.config, this.state)
    ) {
      return false;
    }
    const pool = this.state.getPoolMailbox(email);
    if (!pool?.warmedAt) return false;
    const days = daysSince(pool.warmedAt);
    return Number.isFinite(days) && days < this.config.poolWarmupDays;
  }
}
