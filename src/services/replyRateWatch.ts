/**
 * D311 — reply-rate-drop watch (LOCKED canon, Josh 2026-10-29).
 *
 * When a sending domain's trailing 7-day reply rate (150+ sends) is 40%+
 * below its client's 30-day baseline: (1) alert Josh, then (2) run ONE
 * placement test on that domain's mailboxes only. No isolation test, no
 * pull, no pause, no status change, no mailbox or campaign write: the
 * deps below have no write method on Smartlead at all.
 */
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import { defaultControlTemplate } from "../lib/controlTemplate.js";
import { controlSequence, isolationManualPayload } from "../lib/isolationPlacement.js";
import {
  evaluateReplyRateDrop,
  parseSenderReplyStats,
  replyDropAlertText,
  REPLY_DROP_BASELINE_DAYS,
  REPLY_DROP_REALERT_MS,
  REPLY_DROP_WINDOW_DAYS,
  type ReplyDropFinding,
  type ReplyDropMailbox,
} from "../lib/replyRateDrop.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export const REPLY_DROP_TEST_PREFIX = "Reply drop:";
const MAX_TEST_SENDERS = 20;

/** Read-only Smartlead surface: nothing here can pull, pause or edit. */
type Smartlead = Pick<SmartleadClient, "getMailboxHealthMetrics">;
type SmartDelivery = Pick<SmartDeliveryClient, "createManualPlacement" | "resolveProviderIds">;

export interface ReplyRateWatchDeps {
  smartlead: Smartlead;
  smartDelivery: SmartDelivery | null;
  slack: Pick<SlackClient, "send">;
  state: StateStore;
  config: Pick<AppConfig, "dryRun" | "providerIds"> & Partial<AppConfig>;
  now?: () => Date;
}

export interface ReplyRateWatchResult {
  dryRun: boolean;
  flagged: ReplyDropFinding[];
  alerted: string[];
  tested: Array<{ domain: string; testId: string }>;
  skipped: string[];
  errors: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Sending mailboxes of ACTIVE campaigns with their client. */
export function replyDropMailboxes(
  campaigns: SmartleadCampaign[],
  accounts: SmartleadAccountWithCampaigns[],
): ReplyDropMailbox[] {
  const active = new Map(
    campaigns
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .map((c) => [c.id, c] as const),
  );
  const out: ReplyDropMailbox[] = [];
  for (const account of accounts) {
    const email = accountEmail(account)?.toLowerCase();
    if (!email) continue;
    const onActive = campaignIdsOf(account).filter((id) => active.has(id));
    if (!onActive.length) continue;
    const clientId =
      typeof account.client_id === "number" && account.client_id > 0
        ? account.client_id
        : onActive
            .map((id) => active.get(id)?.client_id)
            .find((id): id is number => typeof id === "number" && id > 0);
    if (!clientId) continue;
    out.push({ email, clientId });
  }
  return out;
}

export class ReplyRateWatchService {
  constructor(private readonly deps: ReplyRateWatchDeps) {}

  async run(opts: {
    campaigns: SmartleadCampaign[];
    accounts: SmartleadAccountWithCampaigns[];
    dryRun?: boolean;
  }): Promise<ReplyRateWatchResult> {
    const { smartlead, smartDelivery, slack, state, config } = this.deps;
    const dryRun = opts.dryRun ?? config.dryRun;
    const now = this.deps.now?.() ?? new Date();
    const result: ReplyRateWatchResult = {
      dryRun,
      flagged: [],
      alerted: [],
      tested: [],
      skipped: [],
      errors: [],
    };
    if (config.enableReplyRateDrop === false) return result;

    const mailboxes = replyDropMailboxes(opts.campaigns, opts.accounts);
    if (!mailboxes.length) {
      result.skipped.push("no sending mailboxes on ACTIVE campaigns");
      return result;
    }

    const end = ymd(now);
    const start = (days: number) => ymd(new Date(now.getTime() - (days - 1) * DAY_MS));
    let stats7;
    let stats30;
    try {
      stats7 = parseSenderReplyStats(
        await smartlead.getMailboxHealthMetrics({
          startDate: start(REPLY_DROP_WINDOW_DAYS),
          endDate: end,
          fullData: true,
        }),
      );
      stats30 = parseSenderReplyStats(
        await smartlead.getMailboxHealthMetrics({
          startDate: start(REPLY_DROP_BASELINE_DAYS),
          endDate: end,
          fullData: true,
        }),
      );
    } catch (error) {
      result.errors.push(
        `health metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
    if (!stats7.length || !stats30.length) {
      result.skipped.push("health metrics carried no reply counts");
      return result;
    }

    result.flagged = evaluateReplyRateDrop({ mailboxes, stats7, stats30 });
    for (const finding of result.flagged) {
      const prior = state.getReplyDrop(finding.domain);
      if (prior && now.getTime() - Date.parse(prior.alertedAt) < REPLY_DROP_REALERT_MS) {
        result.skipped.push(`${finding.domain}: already alerted ${prior.alertedAt.slice(0, 10)}`);
        continue;
      }
      if (dryRun) {
        result.skipped.push(`${finding.domain}: dry run, would alert and test`);
        continue;
      }
      // 1) alert Josh.
      const mention = (config.slackJoshUserIds ?? []).map((id) => `<@${id}>`).join(" ");
      try {
        await slack.send(
          `${mention ? `${mention} ` : ""}${replyDropAlertText(finding)}`.trim(),
          undefined,
          "ops_alert",
        );
        result.alerted.push(finding.domain);
      } catch (error) {
        result.errors.push(
          `${finding.domain} alert: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      state.setReplyDrop({
        domain: finding.domain,
        clientId: finding.clientId,
        alertedAt: now.toISOString(),
        dropPercent: Math.round(finding.dropPercent),
        rate7: Number(finding.rate7.toFixed(2)),
        baselineRate: Number(finding.baselineRate.toFixed(2)),
      });
      // 2) one placement test on that domain only.
      if (!smartDelivery) {
        result.errors.push(`${finding.domain}: SmartDelivery is not configured`);
        continue;
      }
      try {
        const providerIds = await smartDelivery.resolveProviderIds(config.providerIds);
        const template = defaultControlTemplate();
        const created = await smartDelivery.createManualPlacement(
          isolationManualPayload({
            testName: `${REPLY_DROP_TEST_PREFIX} ${finding.domain}`.slice(0, 120),
            description: `D311 reply-rate drop: ${finding.dropPercent.toFixed(0)}% below client baseline. Placement test on this domain only.`,
            senderAccounts: finding.mailboxes.slice(0, MAX_TEST_SENDERS),
            sequence: controlSequence(template, `Reply drop ${finding.domain}`),
            providerIds,
            offCampaignSenders: true,
          }),
        );
        const testId = String(created.id);
        result.tested.push({ domain: finding.domain, testId });
        state.setReplyDrop({ ...state.getReplyDrop(finding.domain)!, testId });
      } catch (error) {
        result.errors.push(
          `${finding.domain} placement test: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await state.save();
    return result;
  }
}
