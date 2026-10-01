import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  bookFromCampaign,
  copyNoticeSlackText,
  diffCopyNotice,
  isCopyNoticeCampaign,
  sequencesFromPayload,
  variantMarks,
  type CopyNoticeBook,
  type CopyNoticeDiff,
} from "../lib/copyNotice.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

const SEQUENCE_GAP_MS = 120;

export interface CopyNoticeBriefResult {
  dryRun: boolean;
  seeded: boolean;
  scanned: number;
  newCampaigns: number;
  newVariants: number;
  posted: boolean;
  errors: string[];
}

/**
 * D216 — 07:00 America/New_York digest for Cayden. First tick seeds the
 * fingerprint book and stays silent so the whole board does not dump.
 * Later ticks Slack only what appeared since the last 7am.
 */
export class CopyNoticeBriefService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<CopyNoticeBriefResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CopyNoticeBriefResult = {
      dryRun,
      seeded: false,
      scanned: 0,
      newCampaigns: 0,
      newVariants: 0,
      posted: false,
      errors: [],
    };

    let campaigns: SmartleadCampaign[];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
      throw error instanceof Error ? error : new Error(message);
    }

    const living = campaigns.filter((campaign) =>
      isCopyNoticeCampaign(campaign, this.config.podControlShellCampaignId),
    );
    const previous = this.state.getCopyNoticeBook();
    const current: CopyNoticeBook = {};
    const marksByCampaign: Record<
      string,
      Array<{ key: string; label: string }>
    > = {};

    for (const campaign of living) {
      result.scanned += 1;
      try {
        const payload = await this.smartlead.getCampaignSequences(campaign.id);
        const sequences = sequencesFromPayload(payload);
        const marks = variantMarks(sequences);
        marksByCampaign[String(campaign.id)] = marks;
        current[String(campaign.id)] = bookFromCampaign(campaign, sequences);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
        const was = previous[String(campaign.id)];
        if (was) current[String(campaign.id)] = was;
      }
      await sleep(SEQUENCE_GAP_MS);
    }
    const seeded = this.state.getCopyNoticeSeededAt() != null;
    if (!seeded) {
      result.seeded = true;
      if (!dryRun) {
        this.state.setCopyNoticeBook(current);
        this.state.setCopyNoticeSeededAt(new Date().toISOString());
        await this.state.save();
      }
      console.log(
        `[copy-notice] seeded ${Object.keys(current).length} campaign(s); silent first tick (D216)`,
      );
      return result;
    }

    const diff: CopyNoticeDiff = diffCopyNotice(
      previous,
      current,
      marksByCampaign,
    );
    result.newCampaigns = diff.newCampaigns.length;
    result.newVariants = diff.newVariants.length;
    const text = copyNoticeSlackText(diff, this.config.slackCaydenUserIds);
    if (text && !dryRun) {
      await this.slack.send(text, undefined, "copy_notice");
      result.posted = true;
    }
    if (!dryRun) {
      this.state.setCopyNoticeBook(current);
      if (text) this.state.setCopyNoticeLastPostedAt(new Date().toISOString());
      await this.state.save();
    }
    console.log(
      `[copy-notice] scanned=${result.scanned} newCampaigns=${result.newCampaigns} newVariants=${result.newVariants} posted=${result.posted} errors=${result.errors.length}`,
    );
    return result;
  }
}
