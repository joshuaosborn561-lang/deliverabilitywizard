import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { isBcpCampaignName } from "../lib/bcp.js";
import { sleep } from "../lib/http.js";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
} from "../lib/mailboxSignature.js";
import {
  needsMinTimeGap,
  readMessagePerDay,
  readMinTimeGapMins,
} from "../lib/mailboxSendSettings.js";
import { totalDailySendCeiling } from "../lib/sendCeiling.js";
import type { SmartleadCampaign, SmartleadEmailAccount } from "../types/index.js";

/**
 * Hold every mailbox at the agreed sending settings.
 *
 * Warmup, daily send volume, min send gap, and signature format are set per
 * mailbox in Smartlead, so a mailbox added by hand, re-imported, or created
 * by InboxKit arrives on whatever default it happened to get. Nothing
 * reconciled them, so the fleet drifted.
 *
 * Gap + daily volume (D24/D30) and ACTIVE-campaign signatures (D41) run on
 * every health pass. Full-fleet signatures/warmup stay on the slower converge
 * so a fleet rewrite cannot starve staffing.
 */

export type MailboxSettingsMode = "gap" | "full" | "active-signatures";

export interface MailboxSettingsResult {
  dryRun: boolean;
  mode: MailboxSettingsMode;
  scanned: number;
  sendLimitSet: number;
  minGapSet: number;
  signatureSet: number;
  warmupEnabled: number;
  errors: string[];
  /** ACTIVE campaigns visited during an active-signatures pass. */
  campaigns?: number;
  skippedNoBrand?: number;
}

export interface SignatureFixSample {
  email: string;
  campaign: string;
  from: string;
  to: string;
}

/** Consecutive failures before the pass gives up for this run. */
const MAX_CONSECUTIVE_FAILURES = 15;

export class MailboxSettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
  ) {}

  /** D30/D24 only — safe to run every health cron. */
  async runGapEnforce(
    opts: { dryRun?: boolean } = {},
  ): Promise<MailboxSettingsResult> {
    return this.run({ ...opts, mode: "gap" });
  }

  /** D41 — live senders only; safe to run every health cron. */
  async runActiveCampaignSignatures(
    opts: { dryRun?: boolean } = {},
  ): Promise<MailboxSettingsResult> {
    return this.run({ ...opts, mode: "active-signatures" });
  }

  async run(
    opts: { dryRun?: boolean; mode?: MailboxSettingsMode } = {},
  ): Promise<MailboxSettingsResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const mode: MailboxSettingsMode = opts.mode ?? "full";
    if (mode === "active-signatures") {
      return this.scanActiveCampaignSignatures(dryRun);
    }

    const result: MailboxSettingsResult = {
      dryRun,
      mode,
      scanned: 0,
      sendLimitSet: 0,
      minGapSet: 0,
      signatureSet: 0,
      warmupEnabled: 0,
      errors: [],
    };

    if (!this.config.enforceMailboxSettings) {
      console.log("[mailbox-settings] Disabled (ENFORCE_MAILBOX_SETTINGS=false)");
      return result;
    }

    // UI: "Message Per Day (Warmups not included)" — write MESSAGE_PER_DAY (D24).
    const target = totalDailySendCeiling(this.config);
    const targetGap = this.config.mailboxMinTimeGapMins;
    const accounts = (await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    })) as SmartleadAccountWithCampaigns[];
    result.scanned = accounts.length;

    const brandByClientId = new Map<number, string>();
    const otherClientBrands: string[] = [];
    if (mode === "full") {
      const clients = await this.smartlead
        .listClients()
        .catch(() => [] as SmartleadClientRecord[]);
      for (const client of clients) {
        const brand = brandFromClientDisplayName(clientDisplayName(client));
        brandByClientId.set(client.id, brand);
        if (brand) otherClientBrands.push(brand);
      }
    }

    console.log(
      `[mailbox-settings] mode=${mode} converging ${accounts.length} mailbox(es) to ${target}/day, min gap ${targetGap}m` +
        (mode === "full" ? ", signatures/warmup" : " (gap+volume only)"),
    );

    let consecutiveFailures = 0;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;

      // Only write when the value differs — needless writes trip the limiter.
      const current = readMessagePerDay(account);
      const needsLimit = !(Number.isFinite(current) && current === target);

      const needsGap = needsMinTimeGap(account, targetGap);

      let needsSignature = false;
      let desiredSig: string | null = null;
      let needsWarmup = false;

      if (mode === "full") {
        const clientId =
          typeof account.client_id === "number" && Number.isFinite(account.client_id)
            ? account.client_id
            : null;
        const clientBrand =
          clientId != null ? brandByClientId.get(clientId) ?? "" : "";
        desiredSig = desiredMailboxSignature({
          fromName: account.from_name,
          signature: account.signature,
          clientBrand,
          otherClientBrands: otherClientBrands.filter((b) => b !== clientBrand),
        });
        needsSignature =
          desiredSig != null && (account.signature ?? "") !== desiredSig;

        const warmup = (account as { warmup_details?: { status?: string } | null })
          .warmup_details;
        needsWarmup =
          !warmup || String(warmup.status ?? "").toUpperCase() !== "ACTIVE";
      }

      if (!needsLimit && !needsGap && !needsSignature && !needsWarmup) continue;

      try {
        if (!dryRun && (needsLimit || needsGap || needsSignature)) {
          const fields: {
            max_email_per_day?: number;
            time_to_wait_in_mins?: number;
            signature?: string;
          } = {};
          if (needsLimit) fields.max_email_per_day = target;
          if (needsGap) fields.time_to_wait_in_mins = targetGap;
          if (needsSignature && desiredSig) fields.signature = desiredSig;
          await this.smartlead.updateEmailAccount(account.id, fields);
          await sleep(150);
        }
        if (needsLimit) result.sendLimitSet += 1;
        if (needsGap) result.minGapSet += 1;
        if (needsSignature) result.signatureSet += 1;

        if (mode === "full" && !dryRun && needsWarmup) {
          await this.smartlead.configureWarmup(account.id, {
            warmup_enabled: true,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
          await sleep(150);
        }
        if (needsWarmup) result.warmupEnabled += 1;

        consecutiveFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[mailbox-settings] ${consecutiveFailures} consecutive failures — stopping this run`,
          );
          break;
        }
        await sleep(2000 * consecutiveFailures);
      }
    }

    console.log(
      `[mailbox-settings] Done (${mode}) — ${result.sendLimitSet} send limit(s)→${target}, ${result.minGapSet} min gap(s)→${targetGap}, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s), ${result.errors.length} error(s)`,
    );
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[mailbox-settings]   error: ${e}`);
    }

    if (!dryRun && result.minGapSet > 0) {
      try {
        await this.slack.send(
          `*Mailbox min-gap drift fixed (D30)*\n${result.minGapSet} mailbox(es) were missing the ${targetGap}-minute Minimum time gap — set now. Gap is enforced on every health pass so this should not recur.`,
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack gap alert failed", error);
      }
    }

    if (
      mode === "full" &&
      !dryRun &&
      (result.sendLimitSet ||
        result.minGapSet ||
        result.signatureSet ||
        result.warmupEnabled)
    ) {
      try {
        await this.slack.send(
          `Mailbox settings: ${result.sendLimitSet}→${target}/day (warmups not included), ${result.minGapSet}→${targetGap}m gap, ${result.signatureSet} signature(s), ${result.warmupEnabled} warmup(s) (of ${result.scanned} scanned).`,
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack notify failed", error);
      }
    }

    return result;
  }

  /**
   * Walk every mailbox on an ACTIVE campaign and converge its signature to
   * `Name\\n{that campaign's client brand}` (D31/D41). Membership comes from
   * per-campaign account lists so a sender that is actually sending cannot
   * be missed because the fleet list omitted `campaign_ids`.
   */
  private async scanActiveCampaignSignatures(
    dryRun: boolean,
  ): Promise<MailboxSettingsResult> {
    const result: MailboxSettingsResult = {
      dryRun,
      mode: "active-signatures",
      scanned: 0,
      sendLimitSet: 0,
      minGapSet: 0,
      signatureSet: 0,
      warmupEnabled: 0,
      errors: [],
      campaigns: 0,
      skippedNoBrand: 0,
    };

    if (!this.config.enforceMailboxSettings) {
      console.log("[mailbox-settings] Disabled (ENFORCE_MAILBOX_SETTINGS=false)");
      return result;
    }

    const [campaigns, clients, fleet] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: false }),
    ]);

    const brandByClientId = new Map<number, string>();
    const allBrands: string[] = [];
    for (const client of clients) {
      const brand = brandFromClientDisplayName(clientDisplayName(client));
      brandByClientId.set(client.id, brand);
      if (brand) allBrands.push(brand);
    }

    const fleetById = new Map<number, SmartleadAccountWithCampaigns>();
    for (const account of fleet as SmartleadAccountWithCampaigns[]) {
      if (typeof account.id === "number") fleetById.set(account.id, account);
    }

    const active = (campaigns as SmartleadCampaign[]).filter(
      (c) => String(c.status ?? "").toUpperCase() === "ACTIVE",
    );
    result.campaigns = active.length;

    console.log(
      `[mailbox-settings] mode=active-signatures scanning ${active.length} ACTIVE campaign(s)`,
    );

    type LiveRow = {
      account: SmartleadEmailAccount;
      campaignName: string;
      clientBrand: string;
    };
    const liveById = new Map<number, LiveRow>();

    for (const campaign of active) {
      let rows: SmartleadEmailAccount[] = [];
      try {
        rows = await this.smartlead.getCampaignEmailAccounts(campaign.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`campaign ${campaign.id} accounts: ${message}`);
        await sleep(150);
        continue;
      }

      const clientId =
        typeof campaign.client_id === "number" && Number.isFinite(campaign.client_id)
          ? campaign.client_id
          : null;
      let clientBrand = clientId != null ? brandByClientId.get(clientId) ?? "" : "";
      if (!clientBrand && isBcpCampaignName(String(campaign.name ?? ""))) {
        clientBrand = "Bolder Cyber Partners";
      }

      for (const row of rows) {
        const nested = (row as { email_account?: SmartleadEmailAccount })
          .email_account;
        const id = row.id ?? nested?.id;
        if (typeof id !== "number" || !Number.isFinite(id)) continue;
        const listed = fleetById.get(id);
        const account: SmartleadEmailAccount = {
          ...(nested ?? {}),
          ...row,
          ...(listed ?? {}),
          id,
          from_name: listed?.from_name ?? row.from_name ?? nested?.from_name,
          signature: listed?.signature ?? row.signature ?? nested?.signature,
        };
        if (!liveById.has(id)) {
          liveById.set(id, {
            account,
            campaignName: String(campaign.name ?? campaign.id),
            clientBrand,
          });
        }
      }
      await sleep(120);
    }

    result.scanned = liveById.size;
    const samples: SignatureFixSample[] = [];
    let consecutiveFailures = 0;

    for (const { account, campaignName, clientBrand } of liveById.values()) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;

      const desiredSig = desiredMailboxSignature({
        fromName: account.from_name,
        signature: account.signature,
        clientBrand,
        otherClientBrands: allBrands.filter((b) => b !== clientBrand),
      });
      if (!desiredSig) {
        result.skippedNoBrand = (result.skippedNoBrand ?? 0) + 1;
        continue;
      }
      if ((account.signature ?? "") === desiredSig) continue;

      try {
        if (!dryRun) {
          await this.smartlead.updateEmailAccount(account.id, {
            signature: desiredSig,
          });
          await sleep(150);
        }
        result.signatureSet += 1;
        if (samples.length < 8) {
          samples.push({
            email,
            campaign: campaignName,
            from: (account.signature ?? "").replace(/\s+/g, " ").slice(0, 80),
            to: desiredSig.replace(/\n/g, " / "),
          });
        }
        console.log(
          `[mailbox-settings] signature ${email} on ${campaignName}: → ${desiredSig.replace(/\n/g, " / ")}`,
        );
        consecutiveFailures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(
            `[mailbox-settings] ${consecutiveFailures} consecutive failures — stopping this run`,
          );
          break;
        }
        await sleep(2000 * consecutiveFailures);
      }
    }

    console.log(
      `[mailbox-settings] Done (active-signatures) — ${result.signatureSet} signature(s) on ${result.scanned} live mailbox(es) across ${result.campaigns} campaign(s), ${result.skippedNoBrand} skipped (no brand), ${result.errors.length} error(s)`,
    );
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[mailbox-settings]   error: ${e}`);
    }

    if (!dryRun && result.signatureSet > 0) {
      const sampleLines = samples
        .map((s) => `• ${s.email} (${s.campaign}): ${s.to}`)
        .join("\n");
      try {
        await this.slack.send(
          `*Active-campaign signatures fixed (D31/D41)*\n${result.signatureSet} mailbox(es) on ACTIVE campaigns were not plain two-line Name / Brand — set now. ${result.scanned} live sender(s) scanned across ${result.campaigns} campaign(s).` +
            (sampleLines ? `\n${sampleLines}` : ""),
        );
      } catch (error) {
        console.warn("[mailbox-settings] Slack signature alert failed", error);
      }
    }

    return result;
  }
}

export { readMessagePerDay, readMinTimeGapMins, needsMinTimeGap };
