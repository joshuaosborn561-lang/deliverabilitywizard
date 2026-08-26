import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  pickSequence,
  sequenceMappingIdOf,
  sequenceSubjectPreview,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  normalizeTestList,
  parseSenderInboxRates,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { htmlFromPlain } from "../lib/controlTemplate.js";
import { stripHtml } from "../lib/copyVariants.js";
import {
  interpretCopyCanary,
  majorityLanded,
  type CopyCanarySplit,
} from "../lib/copyCanary.js";
import {
  canaryFleetBuyAlreadyOpen,
  domainsFromCanaryBuyActions,
} from "../lib/copyCanaryFleet.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { hasLivingUnwarmedCopyCanary } from "../lib/canaryCoverage.js";
import {
  canaryCopyTestName,
  campaignIdFromCanaryTestName,
  isCanaryCopyTestName,
} from "../lib/isolationNames.js";
import { isCanaryShellCampaign } from "../lib/canaryShell.js";
import { copySequence, isolationManualPayload } from "../lib/isolationPlacement.js";
import { sleep } from "../lib/http.js";
import { ensureCanaryShell } from "./canaryShell.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import { isExcluded } from "./campaignTopUp.js";
import {
  addDaysIso,
  OPEN_ENDED_TEST_DAYS,
  paddedScheduleDate,
  schedulerCronValue,
} from "./campaignScanner.js";
import type { PoolMailboxRecord, StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface CopyCanaryAttachResult {
  dryRun: boolean;
  attached: Array<{ campaignId: number; email: string }>;
  removedFromCampaigns: Array<{ campaignId: number; email: string }>;
  testsEnsured: number;
  skipped: string[];
  errors: string[];
  buyRequested: boolean;
}

/**
 * Dedicated unwarmed fleet sends campaign copy via SmartDelivery tests.
 * They stay off live campaigns (D55). Isolation reads that against warmed
 * peers on the campaign's standing test.
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
      removedFromCampaigns: [],
      testsEnsured: 0,
      skipped: [],
      errors: [],
      buyRequested: false,
    };
    if (!this.config.enableCopyCanary) {
      console.log("[copy-canary] Disabled");
      return result;
    }

    this.reconcileFleetPurchase();
    const fleet = this.state.getCopyCanaryFleet();
    const fleetEmails = fleet?.emails ?? [];
    if (!fleetEmails.length) {
      if (this.shouldSkipFleetBuy()) {
        result.skipped.push("canary fleet already bought — waiting on mailboxes");
      } else {
        result.buyRequested = await this.requestFleetBuy();
        result.skipped.push("canary fleet not bought yet");
      }
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
    await this.detachFromCampaigns(campaigns, accountByEmail, dryRun, result);

    const picks = this.fleetReady(accountByEmail);
    if (!picks.length) {
      result.skipped.push("canary fleet not in Smartlead yet");
      await this.state.save();
      return result;
    }

    await this.keepWarmupOff(picks, dryRun);

    const active = campaigns.filter((campaign) => {
      if (isCanaryShellCampaign(campaign)) return false;
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE") return false;
      return !isExcluded(campaign, this.config.topUpExcludeCampaigns);
    });
    const activeIds = new Set(active.map((campaign) => campaign.id));

    let listed: unknown = [];
    let listFailed = false;
    let providerIds: number[] = [];
    if (this.smartDelivery) {
      try {
        listed = await this.smartDelivery.listTests({});
      } catch (error) {
        listFailed = true;
        console.warn("[copy-canary] could not list tests", error);
      }
      if (!listFailed) {
        try {
          providerIds = await this.smartDelivery.resolveProviderIds(
            this.config.providerIds,
          );
        } catch (error) {
          console.warn("[copy-canary] provider id resolve failed", error);
        }
      }
    }

    for (const campaign of active) {
      try {
        const testId = await this.ensureCopyTest(
          campaign,
          campaigns,
          picks,
          dryRun,
          listed,
          listFailed,
          providerIds,
        );
        const emails = picks.map((row) => row.email.toLowerCase());
        this.state.setCopyCanaries(campaign.id, emails, testId);
        result.testsEnsured += 1;
        for (const email of emails) {
          result.attached.push({ campaignId: campaign.id, email });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
        console.warn(`[copy-canary] ensure failed #${campaign.id}: ${message}`);
        this.state.setCopyCanaries(
          campaign.id,
          picks.map((row) => row.email.toLowerCase()),
        );
      }
    }

    for (const [campaignId, record] of Object.entries(
      this.state.getIsolation().copyCanaries,
    )) {
      const id = Number(campaignId);
      if (activeIds.has(id)) continue;
      if (record.testId && this.smartDelivery && !dryRun) {
        await this.smartDelivery.stopAutomatedTest(record.testId).catch(() => undefined);
      }
    }

    if (result.attached.length) {
      console.log(
        `[copy-canary] ${result.testsEnsured} campaign-copy test(s); canaries sit on paused shells, not live campaigns`,
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
      const canaryTestId =
        this.state.getCopyCanaryTestId(campaignId) ??
        testIdOf(
          tests
            .filter(
              (test) =>
                campaignIdFromCanaryTestName(test.test_name) === campaignId ||
                (isCanaryCopyTestName(test.test_name) &&
                  campaignIdOf(test) === String(campaignId)),
            )
            .sort((a, b) =>
              String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
            )[0] ?? {},
        );
      const warmedTestId = testIdOf(
        tests
          .filter(
            (test) =>
              campaignIdOf(test) === String(campaignId) &&
              !isCanaryCopyTestName(test.test_name),
          )
          .sort((a, b) =>
            String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
          )[0] ?? {},
      );

      const threshold = this.config.remediationInboxThreshold;
      const canaryRows = canaryTestId
        ? parseSenderInboxRates(
            await this.smartDelivery.getSenderAccountReport(canaryTestId),
            canaryTestId,
            {
              preferSameEsp: true,
              minSameEspSamples: this.config.minSameEspSamples,
            },
          )
        : [];
      const warmedRows = warmedTestId
        ? parseSenderInboxRates(
            await this.smartDelivery.getSenderAccountReport(warmedTestId),
            warmedTestId,
            {
              preferSameEsp: true,
              minSameEspSamples: this.config.minSameEspSamples,
            },
          )
        : [];

      let unwarmedTested = 0;
      let unwarmedInbox = 0;
      let warmedTested = 0;
      let warmedInbox = 0;
      for (const row of canaryRows) {
        if (!row.scoredSameEsp) continue;
        if (!canaries.has(row.email.toLowerCase())) continue;
        unwarmedTested += 1;
        if (row.inboxRate >= threshold) unwarmedInbox += 1;
      }
      for (const row of warmedRows) {
        if (!row.scoredSameEsp) continue;
        if (canaries.has(row.email.toLowerCase())) continue;
        warmedTested += 1;
        if (row.inboxRate >= threshold) warmedInbox += 1;
      }
      if (!unwarmedTested && !warmedTested) return null;
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

  private async detachFromCampaigns(
    campaigns: SmartleadCampaign[],
    accountByEmail: Map<string, SmartleadAccountWithCampaigns>,
    dryRun: boolean,
    result: CopyCanaryAttachResult,
  ): Promise<void> {
    const fleet = this.state.getCopyCanaryFleet();
    if (!fleet) return;
    const shellIds = new Set(
      campaigns.filter((row) => isCanaryShellCampaign(row)).map((row) => row.id),
    );
    for (const email of fleet.emails) {
      const account = accountByEmail.get(email);
      if (!account) continue;
      for (const campaignId of campaignIdsOf(account)) {
        if (shellIds.has(campaignId)) continue;
        try {
          if (!dryRun) {
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            await sleep(150);
          }
          result.removedFromCampaigns.push({ campaignId, email });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`remove ${email} #${campaignId}: ${message}`);
        }
      }
    }
  }

  private async keepWarmupOff(
    picks: PoolMailboxRecord[],
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun) return;
    for (const pool of picks) {
      const accountId = pool.smartleadAccountId;
      if (!accountId) continue;
      try {
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
        await sleep(120);
      } catch (error) {
        console.warn("[copy-canary] warmup-off failed", pool.email, error);
      }
    }
  }

  private async ensureCopyTest(
    campaign: SmartleadCampaign,
    campaigns: SmartleadCampaign[],
    picks: PoolMailboxRecord[],
    dryRun: boolean,
    listed: unknown,
    listFailed: boolean,
    providerIds: number[],
  ): Promise<string | undefined> {
    if (!this.smartDelivery) {
      throw new Error("SmartDelivery is not configured");
    }

    const existing = this.state.getCopyCanaryTestId(campaign.id);
    // D98 — a list failure must reuse the stored id, not spawn a second test.
    if (listFailed) {
      if (existing) return existing;
      throw new Error("could not list SmartDelivery tests");
    }
    const tests = normalizeTestList(listed);
    if (
      existing &&
      hasLivingUnwarmedCopyCanary(campaign.id, tests, existing)
    ) {
      return existing;
    }
    const found = tests.find(
      (test) => campaignIdFromCanaryTestName(test.test_name) === campaign.id,
    );
    const foundId = found ? testIdOf(found) : undefined;
    if (foundId && hasLivingUnwarmedCopyCanary(campaign.id, tests, foundId)) {
      return foundId;
    }

    const copy = await this.loadCampaignCopy(campaign.id);
    if (!copy.subject && !copy.bodyHtml) {
      throw new Error("no campaign copy to test");
    }
    if (!providerIds.length) {
      throw new Error(
        "no SmartDelivery provider_ids — resolve PROVIDER_IDS or seed providers",
      );
    }
    const senderAccounts = picks.map((row) => row.email.toLowerCase());
    const senderAccountIds = picks
      .map((row) => row.smartleadAccountId)
      .filter((id): id is number => typeof id === "number" && id > 0);
    // D114 — schedule requires campaign_id and those senders must sit
    // on it. Hang the test on a paused canary shell (D56 pattern),
    // never the live campaign (D55).
    const shell = await ensureCanaryShell({
      smartlead: this.smartlead,
      campaigns,
      live: campaign,
      subject: copy.subject || "",
      bodyHtml: copy.bodyHtml,
      senderAccountIds,
      seedEmail: senderAccounts[0],
      dryRun,
      sequenceNumber: this.config.sequenceNumber,
    });
    const payload = isolationManualPayload({
      testName: canaryCopyTestName(campaign.id, campaign.name),
      description: [
        "Dedicated unwarmed canary fleet.",
        "These inboxes sit on a paused canary shell, not the live campaign.",
        `Live campaign ID: ${campaign.id}`,
        `Canary shell ID: ${shell.campaignId}`,
      ].join("\n"),
      senderAccounts,
      sequence: copySequence(
        campaign.name || `Campaign ${campaign.id}`,
        copy.subject || "",
        copy.bodyHtml,
      ),
      providerIds,
      campaignId: shell.campaignId,
      sequenceMappingId: shell.sequenceMappingId,
    });

    if (dryRun) return `dry-run-canary-${campaign.id}`;

    if (this.config.autoPlacementTests) {
      const scheduledAt = paddedScheduleDate();
      const created = await this.smartDelivery.createAutomatedPlacement({
        ...payload,
        every_days: this.config.placementTestEveryDays,
        schedule_start_time: scheduledAt.toISOString(),
        scheduler_cron_value: schedulerCronValue(
          this.config.placementTestEveryDays,
          scheduledAt,
        ),
        test_end_date: addDaysIso(
          new Date(),
          this.config.placementTestEndDays > 0
            ? this.config.placementTestEndDays
            : OPEN_ENDED_TEST_DAYS,
        ),
        provider_ids: providerIds,
      });
      return String(created.id);
    }
    const created = await this.smartDelivery.createManualPlacement(payload);
    return String(created.id);
  }

  private async loadCampaignCopy(
    campaignId: number,
  ): Promise<{
    subject?: string;
    bodyHtml: string;
    sequenceMappingId?: number;
  }> {
    const sequences = await this.smartlead.getCampaignSequences(campaignId);
    const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
    if (!sequence) return { bodyHtml: "" };
    const variant = sequence.sequence_variants?.[0] ?? sequence.variants?.[0];
    const body = variant?.email_body ?? sequence.email_body ?? "";
    const html = /<[a-z][\s\S]*>/i.test(body)
      ? body
      : htmlFromPlain(stripHtml(body) || body);
    return {
      subject: sequenceSubjectPreview(sequence),
      bodyHtml: html,
      sequenceMappingId: sequenceMappingIdOf(sequence),
    };
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

  private reconcileFleetPurchase(): void {
    const actions = this.state.listIsolationActions();
    const bought = domainsFromCanaryBuyActions(actions);
    if (!bought) return;
    const fleet = this.state.getCopyCanaryFleet();
    if (!fleet?.domains.length) {
      const emails = fleet?.emails.length ? fleet.emails : bought.emails;
      this.state.setCopyCanaryFleet({
        status: emails.length ? "awaiting_export" : "awaiting_mailboxes",
        domains: bought.domains,
        googleDomain: bought.domains[0],
        microsoftDomain: bought.domains[1],
        emails,
        actionId: bought.actionId || fleet?.actionId,
        updatedAt: new Date().toISOString(),
      });
    }
    for (const extra of actions) {
      if (extra.kind !== "buy_canary_fleet") continue;
      if (extra.status !== "pending") continue;
      if (extra.id === bought.actionId) continue;
      this.state.upsertIsolationAction({
        ...extra,
        status: "denied",
        decidedAt: new Date().toISOString(),
        decidedBy: "system",
        error: "Already bought. Waiting on mailboxes. No second purchase.",
      });
    }
  }

  private shouldSkipFleetBuy(): boolean {
    return canaryFleetBuyAlreadyOpen(
      this.state.getCopyCanaryFleet(),
      this.state.listIsolationActions(),
    );
  }

  private async requestFleetBuy(): Promise<boolean> {
    if (this.shouldSkipFleetBuy()) return false;
    const opened = await requestIsolationAction({
      store: this.state,
      slack: this.slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy the unwarmed canary fleet",
        proof:
          "Two new domains, three inboxes each — one Google, one Outlook. Warmup stays off. They send campaign copy in placement tests and stay off live campaigns. They are not spare supply.",
        detail: {
          quantity: 2,
          mailboxesPerDomain: 3,
          parentDomain: this.config.isolationBuyParentDomain,
        },
      }),
    });
    if (!opened) return false;
    const fleet = this.state.getCopyCanaryFleet();
    this.state.setCopyCanaryFleet({
      status: "pending",
      domains: fleet?.domains ?? [],
      emails: fleet?.emails ?? [],
      googleDomain: fleet?.googleDomain,
      microsoftDomain: fleet?.microsoftDomain,
      actionId: opened.id,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
}
