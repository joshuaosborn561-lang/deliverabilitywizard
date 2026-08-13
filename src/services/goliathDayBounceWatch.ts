import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  pickSequence,
  sequenceSubjectPreview,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import {
  calendarDateInTimeZone,
  dayBounceRatePercent,
  isGoliathCampaign,
  parseCount,
  shouldTripDayBounce,
} from "../lib/dayBounce.js";
import {
  diagnoseDayBounce,
  diagnosisLabel,
  type DayBounceDiagnosis,
  type SiblingDayStats,
} from "../lib/dayBounceDiagnosis.js";
import {
  classifyCopySignal,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import {
  parseSenderBounceStats,
  shouldRotateForBounces,
} from "../lib/bounceRate.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import type { ProviderwiseRow, SmartleadCampaign } from "../types/index.js";

/**
 * Josh (2026-08-13): watch Goliath campaigns for *calendar-day* bounce
 * (America/Chicago), not lifetime. If a campaign's sends that day exceed 7%
 * bounce → pause, alert Cayden, diagnose delays vs spam/copy vs mailbox rotation.
 */

export interface GoliathDayBounceTrip {
  campaignId: number;
  campaignName: string;
  watchDate: string;
  sent: number;
  bounced: number;
  rate: number;
  paused: boolean;
  diagnosis: DayBounceDiagnosis;
  errors: string[];
}

export interface GoliathDayBounceWatchResult {
  dryRun: boolean;
  enabled: boolean;
  watchDate: string;
  scanned: number;
  trips: GoliathDayBounceTrip[];
  alreadyAlerted: number;
  errors: string[];
}

function inboxPercentFromProvider(row: ProviderwiseRow): number | null {
  if (typeof row.inbox_rate === "number" && Number.isFinite(row.inbox_rate)) {
    return row.inbox_rate <= 1 ? row.inbox_rate * 100 : row.inbox_rate;
  }
  const inbox = row.inbox_count ?? 0;
  const tab = row.tab_count ?? 0;
  const spam = row.spam_count ?? 0;
  const total =
    row.adjusted_total_email_count ??
    row.total_email_count ??
    inbox + tab + spam;
  if (!total) return null;
  return (inbox / total) * 100;
}

function plainFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function caydenMention(config: AppConfig): string {
  const id = config.caydenSlackUserId?.trim();
  if (id) return `<@${id}>`;
  return "*Cayden*";
}

export class GoliathDayBounceWatchService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean; watchDate?: string } = {}): Promise<GoliathDayBounceWatchResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const watchDate =
      opts.watchDate ||
      this.config.goliathBounceWatchDate ||
      calendarDateInTimeZone(this.config.goliathBounceWatchTimezone);

    const result: GoliathDayBounceWatchResult = {
      dryRun,
      enabled: this.config.enableGoliathDayBounceWatch,
      watchDate,
      scanned: 0,
      trips: [],
      alreadyAlerted: 0,
      errors: [],
    };

    if (!this.config.enableGoliathDayBounceWatch) {
      console.log("[goliath-day-bounce] Disabled");
      return result;
    }

    const threshold = this.config.goliathBounceWatchThreshold;
    const minSent = this.config.goliathBounceWatchMinSent;

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

    const goliath = campaigns.filter((c) =>
      isGoliathCampaign(c, this.config.goliathClientId || null),
    );
    // Watch ACTIVE (and already-paused same day so we still diagnose if needed)
    const targets = goliath.filter((c) =>
      /^(ACTIVE|PAUSED)$/i.test(String(c.status ?? "")),
    );
    result.scanned = targets.length;
    console.log(
      `[goliath-day-bounce] Watching ${targets.length} Goliath campaigns for ${watchDate} (${dryRun ? "DRY RUN" : "LIVE"}, >${threshold}% / min ${minSent} sent)`,
    );

    const dayStats = new Map<number, SiblingDayStats>();
    for (const campaign of targets) {
      try {
        const analytics = await this.smartlead.getCampaignAnalyticsByDate(
          campaign.id,
          watchDate,
          watchDate,
        );
        const sent = parseCount(analytics.sent_count);
        const bounced = parseCount(analytics.bounce_count);
        dayStats.set(campaign.id, {
          campaignId: campaign.id,
          name: campaign.name || `Campaign ${campaign.id}`,
          sent,
          bounced,
          rate: dayBounceRatePercent(sent, bounced),
        });
        await sleep(150);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} analytics: ${message}`);
      }
    }

    let bounceByEmail = new Map<string, { bounceRate: number; sent: number }>();
    try {
      const raw = await this.smartlead.getMailboxHealthMetrics({});
      for (const row of parseSenderBounceStats(raw)) {
        bounceByEmail.set(row.email.toLowerCase(), {
          bounceRate: row.bounceRate,
          sent: row.sent,
        });
      }
    } catch (error) {
      console.warn("[goliath-day-bounce] mailbox health metrics unavailable", error);
    }

    const siblings = [...dayStats.values()];

    for (const campaign of targets) {
      const stats = dayStats.get(campaign.id);
      if (!stats) continue;
      if (
        !shouldTripDayBounce({
          sent: stats.sent,
          bounced: stats.bounced,
          thresholdPercent: threshold,
          minSent,
        })
      ) {
        continue;
      }

      const alertKey = `goliath-day-bounce:v1:${watchDate}:${campaign.id}`;
      if (this.state.hasAlert(alertKey)) {
        result.alreadyAlerted += 1;
        continue;
      }

      const trip: GoliathDayBounceTrip = {
        campaignId: campaign.id,
        campaignName: stats.name,
        watchDate,
        sent: stats.sent,
        bounced: stats.bounced,
        rate: stats.rate,
        paused: false,
        diagnosis: {
          primary: "unclear",
          reasons: [],
        },
        errors: [],
      };

      // Pause ACTIVE campaigns immediately once the day threshold trips.
      if (/^ACTIVE$/i.test(String(campaign.status ?? ""))) {
        try {
          if (!dryRun) {
            await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
          }
          trip.paused = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          trip.errors.push(`pause: ${message}`);
        }
      } else {
        trip.paused = false;
      }

      try {
        trip.diagnosis = await this.diagnoseCampaign({
          campaign,
          dayRate: stats.rate,
          watchDate,
          siblings,
          accounts,
          bounceByEmail,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trip.errors.push(`diagnose: ${message}`);
      }

      try {
        await this.alertCayden(trip);
        if (!dryRun) this.state.markAlert(alertKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trip.errors.push(`slack: ${message}`);
      }

      result.trips.push(trip);
      await sleep(200);
    }

    if (result.trips.length || result.errors.length) {
      await this.state.save().catch(() => undefined);
    }

    console.log("[goliath-day-bounce] Done", {
      watchDate,
      scanned: result.scanned,
      trips: result.trips.length,
      alreadyAlerted: result.alreadyAlerted,
      errors: result.errors.length,
    });
    return result;
  }

  private async diagnoseCampaign(opts: {
    campaign: SmartleadCampaign;
    dayRate: number;
    watchDate: string;
    siblings: SiblingDayStats[];
    accounts: SmartleadAccountWithCampaigns[];
    bounceByEmail: Map<string, { bounceRate: number; sent: number }>;
  }): Promise<DayBounceDiagnosis> {
    const categories: Record<string, number> = {};
    try {
      // Chicago day ≈ 05:00Z–05:00Z next day around CDT; Smartlead date filter
      // on statistics uses sent_time. Use the calendar date string window that
      // matched analytics-by-date for the category sample.
      const start = `${opts.watchDate}T00:00:00.000Z`;
      const endDate = new Date(`${opts.watchDate}T00:00:00.000Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const end = endDate.toISOString();
      let offset = 0;
      for (let page = 0; page < 4; page += 1) {
        const stats = await this.smartlead.getCampaignStatistics(opts.campaign.id, {
          emailStatus: "bounced",
          sentTimeStartDate: start,
          sentTimeEndDate: end,
          offset,
          limit: 50,
        });
        const rows = Array.isArray(stats.data) ? stats.data : [];
        if (!rows.length) break;
        for (const row of rows) {
          const cat = String(row.lead_category ?? "none");
          categories[cat] = (categories[cat] ?? 0) + 1;
        }
        offset += rows.length;
        if (rows.length < 50) break;
        await sleep(120);
      }
    } catch (error) {
      console.warn(
        `[goliath-day-bounce] bounce sample #${opts.campaign.id} failed`,
        error,
      );
    }

    let sequenceSubject: string | undefined;
    let sequenceBodyPlain: string | undefined;
    try {
      const sequences = await this.smartlead.getCampaignSequences(opts.campaign.id);
      const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
      if (sequence) {
        sequenceSubject = sequenceSubjectPreview(sequence);
        const variant =
          sequence.sequence_variants?.[0] ?? sequence.variants?.[0];
        const body = sequence.email_body || variant?.email_body || "";
        sequenceBodyPlain = plainFromHtml(body);
        if (!sequence.subject && variant?.subject) {
          sequenceSubject = String(variant.subject);
        }
      }
    } catch {
      // optional
    }

    let copySignal = null as ReturnType<typeof classifyCopySignal> | null;
    try {
      const providers = await this.providerSplits(opts.campaign.id);
      if (providers.length) {
        copySignal = classifyCopySignal(
          providers,
          this.config.deliverabilityThreshold,
        );
      }
    } catch {
      // optional
    }

    const onCampaign = opts.accounts.filter((a) =>
      campaignIdsOf(a).includes(opts.campaign.id),
    );
    const hotMailboxes = onCampaign
      .map((a) => {
        const email = accountEmail(a)?.toLowerCase();
        if (!email) return null;
        const row = opts.bounceByEmail.get(email);
        if (!row) return null;
        return { email, bounceRate: row.bounceRate, sent: row.sent };
      })
      .filter((x): x is { email: string; bounceRate: number; sent: number } =>
        Boolean(x),
      )
      .filter(
        (row) =>
          row.bounceRate > 7 &&
          (row.sent >= 20 ||
            shouldRotateForBounces(
              {
                email: row.email,
                bounceRate: row.bounceRate,
                sent: row.sent,
              },
              this.config.bounceRateThreshold,
              this.config.minBounceSample,
            )),
      )
      .sort((a, b) => b.bounceRate - a.bounceRate)
      .slice(0, 15);

    return diagnoseDayBounce({
      campaignName: opts.campaign.name || `Campaign ${opts.campaign.id}`,
      dayRate: opts.dayRate,
      categories,
      siblings: opts.siblings,
      copySignal,
      sequenceSubject,
      sequenceBodyPlain,
      hotMailboxes,
    });
  }

  private async providerSplits(campaignId: number): Promise<ProviderInboxSplit[]> {
    const listed = normalizeTestList(await this.smartDelivery.listTests({}));
    const enriched = await this.smartDelivery.enrichCampaignIds(listed);
    const test = enriched.find((t) => Number(campaignIdOf(t)) === campaignId);
    const tid = test ? testIdOf(test) : null;
    if (!tid) return [];
    const report = await this.smartDelivery.getProviderwiseReport(tid);
    const rows = Array.isArray(report.result) ? report.result : [];
    const out: ProviderInboxSplit[] = [];
    for (const row of rows) {
      const name = String(row.provider_name ?? row.provider ?? "");
      const inbox = inboxPercentFromProvider(row);
      if (!name || inbox == null) continue;
      out.push({ name, inboxPercent: inbox });
    }
    return out;
  }

  private async alertCayden(trip: GoliathDayBounceTrip): Promise<void> {
    const who = caydenMention(this.config);
    const d = trip.diagnosis;
    const lines = [
      `${who} — *Goliath day-bounce trip*`,
      `Campaign: *#${trip.campaignId} ${trip.campaignName}*`,
      `Watch day: *${trip.watchDate}* (America/Chicago sends window via analytics-by-date)`,
      `Day bounce: *${trip.rate.toFixed(1)}%* (${trip.bounced}/${trip.sent} sends) — threshold 7%`,
      trip.paused
        ? `Action: *PAUSED* the campaign (day bounce over 7%).`
        : `Action: campaign was not ACTIVE (no pause write) — still needs your eyes.`,
      "",
      `*Likely cause:* ${diagnosisLabel(d.primary)}`,
      ...d.reasons.map((r) => `• ${r}`),
      ...(d.hotMailboxes?.length
        ? ["", "*Hot mailboxes:*", ...d.hotMailboxes.map((e) => `• \`${e}\``)]
        : []),
      "",
      "Next: fix the cause above, then START only when day bounce is back under control.",
    ];
    if (trip.errors.length) {
      lines.push("", `Errors: ${trip.errors.join("; ")}`);
    }
    await this.slack.send(lines.join("\n"));
  }
}
