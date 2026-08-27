import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  bounceReasonSnippet,
  classifyBounceText,
  ndrBodyFromHistory,
  type BounceClass,
} from "../lib/bounceReason.js";
import { ymdUtc } from "../lib/campaignDayStats.js";
import { sleep } from "../lib/http.js";
import {
  buildIsolationAction,
  domainRecentlyRetired,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import type {
  BounceResurrectionJob,
  BounceVerdictRecord,
  DeferredResurrectionLead,
} from "../state/store.js";
import type { StateStore } from "../state/store.js";

/**
 * D147/D148 — Josh: "if a bounce is due to an inbox rate level or a copy
 * problem we solve, after it is remediated put those leads back on the
 * campaign so we resend" … "i dont want anything paused anymore — we
 * should be investigating, remediating and readding."
 *
 * The bounce loop opens an incident the moment a burst's verdict blames
 * the sender (D148 — nothing pauses, so there is no restart to wait for).
 * The scan re-reads each bounced lead's OWN NDR — a real bad address
 * stays dead — and parks sender-fault leads until their class's
 * remediation gate opens:
 *   tenant_rate_limit → the next UTC day (Microsoft's cap has reset),
 *   sender_blocked    → the domain's retire ask is resolved (retired, or
 *                       Josh unblocked it in Defender and tapped Cancel),
 *   content_block     → the campaign's copy was edited after the incident.
 * The re-add respects the block/unsubscribe/community lists, and a lead
 * is re-queued at most once per campaign, so a recurring cap can never
 * become a resend loop. This re-sends leads Josh already imported — it
 * never sources leads (D52 untouched). A gate that never opens expires
 * after 7 days and the receipt says what was dropped.
 */

/** Classes whose bounces are the sender's fault, not the address's. */
export const RESURRECTABLE_CLASSES: ReadonlySet<BounceClass> = new Set([
  "tenant_rate_limit",
  "sender_blocked",
  "content_block",
]);

/** Incident window: bounces sent this long before the burst qualify. */
export const RESURRECTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Per-tick budget of leads read (classified or flushed) across all jobs. */
const CLASSIFY_BUDGET = 20;
const PAGE = 20;
/** A verdict this much older than a legacy stamp belongs to another incident. */
const VERDICT_MATCH_MS = 6 * 60 * 60 * 1000;
/** A remediation gate that stays shut this long forfeits its resend. */
export const DEFER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
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

/** The verdict blames the sender when any resurrectable class shows up. */
export function verdictBlamesSender(verdict: BounceVerdictRecord): boolean {
  return (
    RESURRECTABLE_CLASSES.has(verdict.dominant as BounceClass) ||
    [...RESURRECTABLE_CLASSES].some((cls) => verdict.summary.includes(cls))
  );
}

/**
 * D148 tenant gate — the Microsoft daily external-recipient cap resets at
 * midnight UTC, so a capped send only goes out again once the UTC day it
 * bounced in is over.
 */
export function tenantGateOpen(sentAtIso: string, nowMs: number): boolean {
  const sentAt = Date.parse(sentAtIso);
  if (!Number.isFinite(sentAt)) return true;
  return ymdUtc(new Date(nowMs)) > ymdUtc(new Date(sentAt));
}

export class BounceResurrectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      | "listBouncedSendStats"
      | "fetchLeadByEmail"
      | "getLeadMessageHistory"
      | "fetchCampaignSequences"
      | "deleteCampaignLead"
      | "restoreCampaignLead"
    >,
    private readonly state: StateStore,
    private readonly slack?: Pick<
      SlackClient,
      "send" | "notifyIsolationAction"
    >,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * D148 — called by the bounce loop right after it classifies a fresh
   * burst. Opens the incident when the verdict blames the sender; folds a
   * repeat burst into the already-open incident instead of restarting it.
   */
  noteIncident(
    campaign: { id: number; name: string },
    verdict: BounceVerdictRecord,
  ): void {
    if (this.config.dryRun) return;
    if (!verdictBlamesSender(verdict)) return;
    const nowIso = new Date(this.clock()).toISOString();
    const existing = this.state.getBounceResurrectionJob(campaign.id);
    if (existing && !existing.done) {
      existing.windowEnd = nowIso;
      existing.lastBurstAt = nowIso;
      existing.verdictSummary = verdict.summary;
      this.state.upsertBounceResurrectionJob(existing);
      return;
    }
    this.state.upsertBounceResurrectionJob({
      campaignId: campaign.id,
      campaignName: campaign.name,
      openedAt: nowIso,
      windowStart: new Date(
        this.clock() - RESURRECTION_LOOKBACK_MS,
      ).toISOString(),
      windowEnd: nowIso,
      lastBurstAt: nowIso,
      verdictSummary: verdict.summary,
      offset: 0,
      scanDone: false,
      deferred: [],
      copyEditedAt: null,
      requeued: 0,
      receipted: 0,
      skippedDead: 0,
      skippedOther: 0,
      dropped: 0,
      done: false,
    });
    console.log(
      `[bounce-resurrect] #${campaign.id} ${campaign.name} opened a sender-fault incident (${verdict.summary}) — leads re-queue as each remediation lands (D148)`,
    );
  }

  /** Fold a still-burning burst into the open incident (cooldown path). */
  extendIncident(campaignId: number): void {
    if (this.config.dryRun) return;
    const job = this.state.getBounceResurrectionJob(campaignId);
    if (!job || job.done) return;
    const nowIso = new Date(this.clock()).toISOString();
    job.windowEnd = nowIso;
    job.lastBurstAt = nowIso;
    this.state.upsertBounceResurrectionJob(job);
  }

  /**
   * Pre-D148 transition — deploys before D148 stamped their pauses; when
   * Josh STARTs one of those campaigns the stored verdict still owes its
   * resend (D147), so the loop opens the incident from the stamp exactly
   * where the stamp drains. New code never writes stamps.
   */
  noteRestart(campaign: { id: number; name: string }): void {
    if (this.config.dryRun) return;
    const pausedAt = this.state.getBouncePausedAt(campaign.id);
    if (!pausedAt) return;
    const existing = this.state.getBounceResurrectionJob(campaign.id);
    if (existing && !existing.done) return;

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
    if (!verdictBlamesSender(verdict)) return;

    const nowIso = new Date(this.clock()).toISOString();
    this.state.upsertBounceResurrectionJob({
      campaignId: campaign.id,
      campaignName: campaign.name,
      openedAt: nowIso,
      windowStart: new Date(pausedAtMs - RESURRECTION_LOOKBACK_MS).toISOString(),
      // No sends happened while paused, so "now" closes the same window.
      windowEnd: nowIso,
      lastBurstAt: nowIso,
      verdictSummary: verdict.summary,
      offset: 0,
      scanDone: false,
      deferred: [],
      copyEditedAt: null,
      requeued: 0,
      receipted: 0,
      skippedDead: 0,
      skippedOther: 0,
      dropped: 0,
      done: false,
    });
    console.log(
      `[bounce-resurrect] #${campaign.id} ${campaign.name} restarted after a pre-D148 sender-fault pause (${verdict.summary}) — re-queueing the incident's bounced leads (D147)`,
    );
  }

  /**
   * D148 transition safety — a fresh sender-fault verdict whose campaign
   * has NO incident record at all gets its incident opened here. The
   * burst normally opens the incident in the same pass that stores the
   * verdict, but a deploy race can eat that step: on 2026-08-27 a
   * stale-branch deploy cleared the four Engagers pause stamps without
   * opening their jobs, which would have silently forfeited their
   * resends.
   */
  private sweepOrphanVerdicts(): void {
    const nowMs = this.clock();
    for (const verdict of this.state.listBounceVerdicts()) {
      if (!verdictBlamesSender(verdict)) continue;
      const at = Date.parse(verdict.at);
      if (!Number.isFinite(at) || nowMs - at > RESURRECTION_LOOKBACK_MS) {
        continue;
      }
      if (this.state.getBounceResurrectionJob(verdict.campaignId)) continue;
      const nowIso = new Date(nowMs).toISOString();
      this.state.upsertBounceResurrectionJob({
        campaignId: verdict.campaignId,
        campaignName: `#${verdict.campaignId}`,
        openedAt: nowIso,
        windowStart: new Date(at - RESURRECTION_LOOKBACK_MS).toISOString(),
        windowEnd: nowIso,
        lastBurstAt: nowIso,
        verdictSummary: verdict.summary,
        offset: 0,
        scanDone: false,
        deferred: [],
        copyEditedAt: null,
        requeued: 0,
        receipted: 0,
        skippedDead: 0,
        skippedOther: 0,
        dropped: 0,
        done: false,
      });
      console.log(
        `[bounce-resurrect] #${verdict.campaignId} sender-fault verdict (${verdict.summary}) had no incident — opened from the verdict sweep (D148)`,
      );
    }
  }

  /** Work every open job inside the per-tick budget. */
  async work(): Promise<BounceResurrectionWorkResult> {
    const result: BounceResurrectionWorkResult = {
      jobs: 0,
      classified: 0,
      requeued: 0,
      skippedDead: 0,
      errors: [],
    };
    if (this.config.dryRun) return result;
    this.sweepOrphanVerdicts();
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
    if (result.classified || result.requeued || result.errors.length) {
      console.log(
        `[bounce-resurrect] jobs=${result.jobs} classified=${result.classified} requeued=${result.requeued} stayedDead=${result.skippedDead} errors=${result.errors.length}${result.errors.length ? ` — ${result.errors.slice(0, 3).join(" | ")}` : ""}`,
      );
    }
    return result;
  }

  private async workJob(
    job: BounceResurrectionJob,
    budget: number,
    result: BounceResurrectionWorkResult,
  ): Promise<number> {
    const nowMs = this.clock();

    // A gate that never opened in 7 days forfeits the resend — say so.
    if (nowMs - Date.parse(job.openedAt) > DEFER_EXPIRY_MS) {
      job.dropped += job.deferred.length;
      job.deferred = [];
      job.scanDone = true;
      await this.finishJob(job);
      return budget;
    }

    budget = await this.scanJob(job, budget, result);
    budget = await this.flushJob(job, budget, result, nowMs);

    this.state.upsertBounceResurrectionJob(job);
    if (job.scanDone && job.deferred.length === 0 && !job.done) {
      await this.finishJob(job);
    }
    return budget;
  }

  /** Phase 1 — page the bounced rows, classify each lead's own NDR, park. */
  private async scanJob(
    job: BounceResurrectionJob,
    budget: number,
    result: BounceResurrectionWorkResult,
  ): Promise<number> {
    const windowStart = Date.parse(job.windowStart);
    const windowEnd = Date.parse(job.windowEnd);

    while (!job.scanDone && budget > 0) {
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
        job.scanDone = true;
        return budget;
      }

      for (const row of rows) {
        if (budget <= 0) break;
        const email = String(row.lead_email ?? "").toLowerCase();
        const sentIso = String(row.sent_time ?? "");
        const sentAt = Date.parse(sentIso);
        if (
          !email ||
          !Number.isFinite(sentAt) ||
          sentAt < windowStart ||
          sentAt > windowEnd ||
          this.state.wasLeadResurrected(job.campaignId, email) ||
          job.deferred.some((entry) => entry.email === email)
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

        const domain = senderDomainFromHistory(history);
        job.deferred.push({
          email,
          cls: bounceClass,
          domain,
          sentAt: sentIso,
        });
        job.offset += 1;
        if (bounceClass === "sender_blocked" && ndr) {
          await this.openSenderBlockAsk(job.campaignId, email, domain, ndr);
        }
        console.log(
          `[bounce-resurrect] parked ${email} on #${job.campaignId} (${bounceClass}) until its remediation gate opens`,
        );
      }

      this.state.upsertBounceResurrectionJob(job);
      if (job.offset >= total) {
        job.scanDone = true;
        return budget;
      }
      if (budget <= 0) return budget;
    }
    return budget;
  }

  /** Phase 2 — re-queue every parked lead whose remediation gate is open. */
  private async flushJob(
    job: BounceResurrectionJob,
    budget: number,
    result: BounceResurrectionWorkResult,
    nowMs: number,
  ): Promise<number> {
    if (!job.deferred.length) return budget;

    // Content gate probe: one sequences read per tick, only while content
    // leads are parked and no edit has been seen yet.
    if (
      !job.copyEditedAt &&
      job.deferred.some((entry) => entry.cls === "content_block")
    ) {
      const editedAt = await this.copyEditedAfter(job);
      if (editedAt) job.copyEditedAt = editedAt;
    }

    const keep: DeferredResurrectionLead[] = [];
    let starved = false;
    for (let i = 0; i < job.deferred.length; i += 1) {
      const entry = job.deferred[i]!;
      // Replay safety: a tick that dies mid-flush keeps its remaining
      // entries, and the survivors can include a lead whose resend
      // already went out before the failure (live 19:31Z on 8/27:
      // bjohnson@ was re-queued twice this way). The ledger, not the
      // deferred list, is the truth about who already went.
      if (this.state.wasLeadResurrected(job.campaignId, entry.email)) {
        job.skippedOther += 1;
        continue;
      }
      if (!this.gateOpen(entry, job, nowMs)) {
        keep.push(entry);
        continue;
      }
      if (budget <= 0) {
        starved = true;
        keep.push(...job.deferred.slice(i));
        break;
      }

      budget -= 1;
      try {
        const lead = (await this.smartlead.fetchLeadByEmail(
          entry.email,
        )) as Record<string, unknown> | null;
        const leadId = Number(lead?.id);
        if (!lead || !Number.isFinite(leadId)) {
          job.skippedOther += 1;
          continue;
        }
        await this.smartlead.deleteCampaignLead(job.campaignId, leadId);
        await sleep(WRITE_GAP_MS);
        await this.smartlead.restoreCampaignLead(
          job.campaignId,
          restorableLead(entry.email, lead),
        );
        await sleep(WRITE_GAP_MS);
        this.state.markLeadResurrected(job.campaignId, entry.email);
        job.requeued += 1;
        result.requeued += 1;
        console.log(
          `[bounce-resurrect] re-queued ${entry.email} on #${job.campaignId} (${entry.cls} remediated)`,
        );
      } catch (error) {
        // One rate-limited lead must not abort the whole flush — keep the
        // entry for the next tick and move on.
        keep.push(entry);
        result.errors.push(
          `#${job.campaignId} ${entry.email}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    job.deferred = keep;

    // Receipt once per flushed wave: everything currently flushable went
    // out (not budget-starved) and the count moved since the last receipt.
    if (!starved && job.requeued > job.receipted && !job.done) {
      await this.sendReceipt(job);
    }
    return budget;
  }

  /**
   * D146/D148 — a 5.1.8 found during the incident re-scan is the same
   * burned-domain signal as one found in a burst sample: the block never
   * resets on its own, so the retire ask opens here too. (The 8/27 live
   * block was classified before D146 shipped, so the burst path never saw
   * it as sender_blocked.) The pending ask is also what holds this
   * lead's resend gate until Josh resolves it.
   */
  private async openSenderBlockAsk(
    campaignId: number,
    leadEmail: string,
    domain: string | null,
    ndr: string,
  ): Promise<void> {
    if (!domain) return;
    // Stale pre-retire bounces must not re-ask for a domain Josh already
    // retired (D146/D148 refinement).
    if (domainRecentlyRetired(this.state, domain, this.clock())) return;
    const slack = this.slack;
    if (!slack || typeof slack.notifyIsolationAction !== "function") return;
    try {
      const opened = await requestIsolationAction({
        store: this.state,
        slack,
        action: buildIsolationAction({
          kind: "retire_domain",
          title: `Retire ${domain} — Microsoft flagged it as a bad outbound sender`,
          proof: [
            `Found while re-queueing incident bounces: ${leadEmail} on campaign #${campaignId} bounced 550 5.1.8 from a ${domain} sender.`,
            `"${bounceReasonSnippet(ndr).slice(0, 160)}"`,
            "The block does not reset at midnight — the account sits in Defender's Restricted entities until unblocked. Cancel retires nothing; unblock the sender in Defender instead. The lead re-queues once this ask is resolved.",
          ].join("\n"),
          detail: { domain },
        }),
      });
      if (opened) {
        console.log(
          `[bounce-resurrect] burned-domain ask opened for ${domain} — sender block found in the incident scan (D146/D148)`,
        );
      }
    } catch (error) {
      console.warn(
        `[bounce-resurrect] retire ask for ${domain} failed to open`,
        error,
      );
    }
  }

  private gateOpen(
    entry: DeferredResurrectionLead,
    job: BounceResurrectionJob,
    nowMs: number,
  ): boolean {
    if (entry.cls === "tenant_rate_limit") {
      return tenantGateOpen(entry.sentAt, nowMs);
    }
    if (entry.cls === "sender_blocked") {
      // Resolved = Josh retired the domain (boxes pulled) or cancelled the
      // ask because he unblocked the sender in Defender. An unknown domain
      // can never be verified — it waits out the expiry.
      if (!entry.domain) return false;
      return !this.state
        .listIsolationActions()
        .some(
          (row) =>
            row.kind === "retire_domain" &&
            row.status === "pending" &&
            row.detail.domain === entry.domain,
        );
    }
    if (entry.cls === "content_block") return Boolean(job.copyEditedAt);
    return true;
  }

  /** Newest sequence edit after the incident opened, or null. */
  private async copyEditedAfter(
    job: BounceResurrectionJob,
  ): Promise<string | null> {
    try {
      const payload = await this.smartlead.fetchCampaignSequences(
        job.campaignId,
      );
      const steps = Array.isArray(payload)
        ? (payload as Array<Record<string, unknown>>)
        : [];
      const openedAt = Date.parse(job.openedAt);
      let newest: string | null = null;
      for (const step of steps) {
        const stamp = String(step.updated_at ?? step.created_at ?? "");
        const at = Date.parse(stamp);
        if (!Number.isFinite(at) || at <= openedAt) continue;
        if (!newest || at > Date.parse(newest)) newest = stamp;
      }
      return newest;
    } catch {
      return null; // unreadable — try again next tick
    }
  }

  private async finishJob(job: BounceResurrectionJob): Promise<void> {
    job.done = true;
    this.state.upsertBounceResurrectionJob(job);
    console.log(
      `[bounce-resurrect] #${job.campaignId} ${job.campaignName} done — re-queued ${job.requeued}, ${job.skippedDead} stayed dead, ${job.skippedOther} out of scope, ${job.dropped} expired unremediated`,
    );
    if (job.requeued > job.receipted || job.dropped > 0) {
      await this.sendReceipt(job);
    }
  }

  private async sendReceipt(job: BounceResurrectionJob): Promise<void> {
    if (!this.slack) {
      job.receipted = job.requeued;
      return;
    }
    const fresh = job.requeued - job.receipted;
    const lines: string[] = [];
    if (fresh > 0) {
      lines.push(
        `*Re-queued ${fresh} bounced lead${fresh === 1 ? "" : "s"} on ${job.campaignName}.*`,
        `Their bounces were the sender's fault (${job.verdictSummary}), not bad addresses — the remediation landed, so they go out again on the campaign's normal schedule.${job.skippedDead ? ` ${job.skippedDead} stayed dead (their own bounce said bad address).` : ""}`,
      );
    }
    if (job.done && job.dropped > 0) {
      lines.push(
        `${job.dropped} lead${job.dropped === 1 ? "" : "s"} expired un-resent — their remediation gate never opened within 7 days.`,
      );
    }
    if (!lines.length) {
      job.receipted = job.requeued;
      return;
    }
    try {
      await this.slack.send(lines.join("\n"), undefined, "action_result");
      job.receipted = job.requeued;
      this.state.upsertBounceResurrectionJob(job);
    } catch (error) {
      console.warn("[bounce-resurrect] Slack receipt failed", error);
    }
  }
}

/** The mailbox domain a bounced send went out from, read off its history. */
function senderDomainFromHistory(history: unknown): string | null {
  const entries = (history as { history?: Array<Record<string, unknown>> })
    ?.history;
  if (!Array.isArray(entries)) return null;
  const sent = entries.find(
    (entry) => String(entry.type ?? "").toUpperCase() === "SENT",
  );
  const from = String(sent?.from ?? "").toLowerCase();
  const domain = from.split("@")[1]?.trim();
  return domain || null;
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
