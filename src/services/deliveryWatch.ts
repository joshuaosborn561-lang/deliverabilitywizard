import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  addUtcDays,
  nyDateLabel,
  oooFromStatistics,
  statsFromAnalytics,
  ymdUtc,
} from "../lib/campaignDayStats.js";
import { detectDeliveryCollapse, oooDetectionEnabled } from "../lib/deliveryWatch.js";
import { isExcluded } from "./campaignTopUp.js";
import type { IsolationBranchService } from "./isolationBranch.js";
import type { StateStore } from "../state/store.js";

export interface DeliveryWatchResult {
  dryRun: boolean;
  scanned: number;
  hits: number;
  oooOff: number;
  errors: string[];
}

export class DeliveryWatchService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly branch: IsolationBranchService,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<DeliveryWatchResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: DeliveryWatchResult = {
      dryRun,
      scanned: 0,
      hits: 0,
      oooOff: 0,
      errors: [],
    };
    if (!this.config.enableDeliveryWatch) return result;

    const today = ymdUtc(new Date());
    const yesterday = addUtcDays(today, -1);
    const campaigns = (await this.smartlead.listCampaigns()).filter(
      (campaign) =>
        String(campaign.status ?? "").toUpperCase() === "ACTIVE" &&
        !isExcluded(campaign, this.config.topUpExcludeCampaigns),
    );

    const oooOff: Array<{ id: number; name: string }> = [];

    for (const campaign of campaigns) {
      result.scanned += 1;
      try {
        const settings = await this.smartlead
          .getCampaignSettings(campaign.id)
          .catch(() => null);
        const oooOn = oooDetectionEnabled(settings);
        if (oooOn === false) {
          oooOff.push({ id: campaign.id, name: campaign.name });
          continue;
        }

        const [todayStats, yesterdayStats, statistics] = await Promise.all([
          this.smartlead.getCampaignAnalyticsByDate(campaign.id, today, today),
          this.smartlead.getCampaignAnalyticsByDate(
            campaign.id,
            yesterday,
            yesterday,
          ),
          this.smartlead.getCampaignStatistics(campaign.id).catch(() => null),
        ]);
        const todayRow = statsFromAnalytics(todayStats);
        const yesterdayRow = statsFromAnalytics(yesterdayStats);
        const oooToday = todayRow.ooo ?? oooFromStatistics(statistics);
        const watch = detectDeliveryCollapse({
          yesterday: {
            replies: yesterdayRow.replies,
            ooo: yesterdayRow.ooo ?? 0,
            bounceRate: yesterdayRow.bounceRate,
            sent: yesterdayRow.sent,
          },
          today: {
            replies: todayRow.replies,
            ooo: oooToday ?? 0,
            bounceRate: todayRow.bounceRate,
            sent: todayRow.sent,
          },
          infraUnchanged: true,
          sequenceUnchanged: true,
          listUnchanged: true,
        });
        if (!watch.hit) continue;
        result.hits += 1;
        this.state.markCopySuspect({
          campaignId: campaign.id,
          campaignName: campaign.name,
          at: new Date().toISOString(),
          evaluatedAt: undefined,
        });
        if (!dryRun) {
          const run = await this.branch.evaluate(campaign.id, {
            campaignInSpam: true,
            silent: true,
          });
          await this.slack.notifyIsolationVerdict({
            campaignName: campaign.name,
            dateLabel: nyDateLabel(),
            verdict: run.verdict,
            reason: run.reason,
            repliesFrom: watch.repliesFrom,
            repliesTo: watch.repliesTo,
            oooFrom: watch.oooFrom,
            oooTo: watch.oooTo,
            bounceFlat: true,
            teardownStarted: run.teardownStarted,
          });
        }
      } catch (error) {
        result.errors.push(
          `#${campaign.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    result.oooOff = oooOff.length;
    if (oooOff.length) {
      await this.slack.notifyOooDetectionOff(oooOff).catch(() => undefined);
    }
    this.state.patchIsolation({ lastDeliveryWatchAt: new Date().toISOString() });
    await this.state.save();
    return result;
  }
}
