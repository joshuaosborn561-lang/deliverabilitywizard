import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  classifyBounceText,
  ndrBodyFromHistory,
  type BounceClass,
} from "../lib/bounceReason.js";
import { sleep } from "../lib/http.js";
import type { BounceResurrectionJob } from "../state/store.js";
import type { StateStore } from "../state/store.js";

/**
 * D147 — Josh: "if a bounce is due to an inbox rate level or a copy
 * problem we solve, after it is remediated put those leads back on the
 * campaign so we resend."
 *
 * The remediation signal is the one canon already has: a bounce-paused
 * campaign only goes ACTIVE again when a human STARTs it (D40/D128). When
 * the bounce loop sees that restart and the incident's verdict blamed the
 * sender — capped tenant, blocked sender, content block — it opens a job
 * that re-queues the incident's bounced leads: each lead's OWN NDR is
 * re-read first, so a real bad address stays dead; the re-add respects
 * the block/unsubscribe/community lists; and a lead is re-queued at most
 * once per campaign, so a recurring cap can never turn this into a
 * resend loop. This re-sends leads Josh already imported — it never
 * sources leads (D52 untouched).
 */

/** Classes whose bounces are the sender's fault, not the address's. */
export const RESURRECTABLE_CLASSES: ReadonlySet<BounceClass> = new Set([
  "tenant_rate_limit",
  "sender_blocked",
  "content_block",
]);

/** Incident window: bounces sent this long before the pause qualify. */
export const RESURRECTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Per-tick budget of leads read+classified across all jobs (rate care). */
const CLASSIFY_BUDGET = 20;
const PAGE = 20;
/** A verdict this much older than the pause belongs to another incident. */
const VERDICT_MATCH_MS = 6 * 60 * 60 * 1000;
const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;

/** Lead fields carried over so merge tags keep rendering after the re-add. */
const CARRIED_FIELDS = [
  "first_name",
  "last_name",
  "company_name",
  "phone_number",
  "website",
  "location",
  "linkedin_profile",
  "custom_fields",
] as const;

export interface BounceResurrectionWorkResult {
  jobs: number;
  classified: number;
  requeued: number;
  skippedDead: number;
  errors: string[];
}

export class BounceResurrectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      | "listBouncedSendStats"
      | "fetchLeadByEmail"
      | "getLeadMessageHistory"
      | "deleteCampaignLead"
      | "restoreCampaignLead"
    >,
    private readonly state: StateStore,
    private readonly slack?: Pick<SlackClient, "send">,
  ) {}

  /**
   * Called by the bounce loop when it sees a stamped campaign ACTIVE
   * again — BEFORE the stamp is cleared. Opens a job only when the
   * stored verdict for that incident blamed the sender.
   */
  noteRestart(campaign: { id: number; name: string }): void {
    if (this.config.dryRun) return;
    const pausedAt = this.state.getBouncePausedAt(campaign.id);
    if (!pausedAt) return;
    const existing = this.state.getBounceResurrectionJob(campaign.id);
    if (existing && !existing.done) return;
    if (existing && existing.pausedAt === pausedAt) return;

    const verdict = this.state.getBounceVerdict(campaign.id);
    if (!verdict) return;
    const verdictAt = Date.parse(verdict.at);
    const pausedAtMs = Date.parse(pausedAt);
    if (
      !Number.isFinite(verdictAt) ||
      !Number.isFinite(pausedAtMs) ||
      Math.abs(verdictAt - pausedAtMs) > VERDICT_MATCH_MS
    ) {
      return;
    }
    const senderFault =
      RESURRECTABLE_CLASSES.has(verdict.dominant as BounceClass) ||
      [...RESURRECTABLE_CLASSES].some((cls) =>
        verdict.summary.includes(cls),
      );
    if (!senderFault) return;

    this.state.upsertBounceResurrectionJob({
      campaignId: campaign.id,
      campaignName: campaign.name,
      pausedAt,
      restartedAt: new Date().toISOString(),
      verdictSummary: verdict.summary,
      offset: 0,
      requeued: 0,
      skippedDead: 0,
      skippedOther: 0,
      done: false,
    });
    console.log(
      `[bounce-resurrect] #${campaign.id} ${campaign.name} restarted after a sender-fault pause (${verdict.summary}) — re-queueing the incident's bounced leads (D147)`,
    );
  }

  /** Work every open job inside the per-tick classify budget. */
  async work(): Promise<BounceResurrectionWorkResult> {
    const result: BounceResurrectionWorkResult = {
      jobs: 0,
      classified: 0,
      requeued: 0,
      skippedDead: 0,
      errors: [],
    };
    if (this.config.dryRun) return result;
    const jobs = this.state
      .listBounceResurrectionJobs()
      .filter((job) => !job.done);
    if (!jobs.length) return result;

    let budget = CLASSIFY_BUDGET;
    let mutated = false;
    for (const job of jobs) {
      result.jobs += 1;
      try {
        budget = await this.workJob(job, budget, result);
        mutated = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${job.campaignId}: ${message}`);
        this.state.upsertBounceResurrectionJob(job);
      }
      if (budget <= 0) break;
    }
    if (mutated) await this.state.save();
    if (result.classified || result.errors.length) {
      console.log(
        `[bounce-resurrect] jobs=${result.jobs} classified=${result.classified} requeued=${result.requeued} stayedDead=${result.skippedDead} errors=${result.errors.length}`,
      );
    }
    return result;
  }

  private async workJob(
    job: BounceResurrectionJob,
    budget: number,
    result: BounceResurrectionWorkResult,
  ): Promise<number> {
    const windowStart = Date.parse(job.pausedAt) - RESURRECTION_LOOKBACK_MS;
    const windowEnd = Date.parse(job.restartedAt);

    while (budget > 0) {
      const payload = (await this.smartlead.listBouncedSendStats(
        job.campaignId,
        PAGE,
        job.offset,
      )) as { total_stats?: unknown; data?: unknown } | null;
      const rows = Array.isArray(payload?.data)
        ? (payload!.data as Array<Record<string, unknown>>)
        : [];
      const total = Number(payload?.total_stats ?? rows.length);
      if (!rows.length) {
        await this.finishJob(job);
        return budget;
      }

      for (const row of rows) {
        if (budget <= 0) break;
        const email = String(row.lead_email ?? "").toLowerCase();
        const sentAt = Date.parse(String(row.sent_time ?? ""));
        if (
          !email ||
          !Number.isFinite(sentAt) ||
          sentAt < windowStart ||
          sentAt > windowEnd ||
          this.state.wasLeadResurrected(job.campaignId, email)
        ) {
          job.skippedOther += 1;
          job.offset += 1;
          continue;
        }

        budget -= 1;
        result.classified += 1;
        const lead = (await this.smartlead.fetchLeadByEmail(email)) as Record<
          string,
          unknown
        > | null;
        const leadId = Number(lead?.id);
        if (!lead || !Number.isFinite(leadId)) {
          job.skippedOther += 1;
          job.offset += 1;
          continue;
        }
        const history = await this.smartlead.getLeadMessageHistory(
          job.campaignId,
          leadId,
        );
        const ndr = ndrBodyFromHistory(history);
        const bounceClass = ndr ? classifyBounceText(ndr) : "other";
        if (!RESURRECTABLE_CLASSES.has(bounceClass)) {
          // A real bad address (or an unreadable bounce) stays dead —
          // resending it would be a fresh hard bounce on purpose.
          job.skippedDead += 1;
          result.skippedDead += 1;
          job.offset += 1;
          continue;
        }

        await this.smartlead.deleteCampaignLead(job.campaignId, leadId);
        await sleep(WRITE_GAP_MS);
        await this.smartlead.restoreCampaignLead(
          job.campaignId,
          restorableLead(email, lead),
        );
        await sleep(WRITE_GAP_MS);
        this.state.markLeadResurrected(job.campaignId, email);
        job.requeued += 1;
        result.requeued += 1;
        // The delete may shrink the bounced list under the cursor, so a
        // resurrected row does NOT advance the offset; if the row lingers
        // instead, the ledger skips it on the re-read and advances then.
        console.log(
          `[bounce-resurrect] re-queued ${email} on #${job.campaignId} (${bounceClass})`,
        );
      }

      this.state.upsertBounceResurrectionJob(job);
      // Correct under both list behaviors: when a delete shrinks the
      // bounced list the total shrinks with the offset's frame; when it
      // does not, the ledger re-read advances the offset to the same end.
      if (job.offset >= total) {
        await this.finishJob(job);
        return budget;
      }
      if (budget <= 0) return budget;
    }
    return budget;
  }

  private async finishJob(job: BounceResurrectionJob): Promise<void> {
    job.done = true;
    this.state.upsertBounceResurrectionJob(job);
    console.log(
      `[bounce-resurrect] #${job.campaignId} ${job.campaignName} done — re-queued ${job.requeued}, ${job.skippedDead} stayed dead, ${job.skippedOther} out of scope`,
    );
    if (this.slack && job.requeued > 0) {
      try {
        await this.slack.send(
          [
            `*Re-queued ${job.requeued} bounced lead${job.requeued === 1 ? "" : "s"} on ${job.campaignName}.*`,
            `Their bounces were the sender's fault (${job.verdictSummary}), not bad addresses — after the fix and your restart they go out again on the campaign's normal schedule.${job.skippedDead ? ` ${job.skippedDead} stayed dead (their own bounce said bad address).` : ""}`,
          ].join("\n"),
          undefined,
          "action_result",
        );
      } catch (error) {
        console.warn("[bounce-resurrect] Slack receipt failed", error);
      }
    }
  }
}

/** The re-add payload: same email, merge fields carried over. */
export function restorableLead(
  email: string,
  lead: Record<string, unknown>,
): { email: string } & Record<string, unknown> {
  const out: { email: string } & Record<string, unknown> = { email };
  for (const field of CARRIED_FIELDS) {
    const value = lead[field];
    if (value != null && value !== "") out[field] = value;
  }
  return out;
}
