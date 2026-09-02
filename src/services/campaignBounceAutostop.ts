import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import {
  bounceReasonSnippet,
  classifyBounceText,
  leadCategoryOf,
  ndrBodyFromHistory,
  preferNdrRows,
  sampleSenderDomains,
  senderBlockScanHint,
  summarizeBounceSamples,
  type BounceSample,
} from "../lib/bounceReason.js";
import { statsFromAnalytics, ymdUtc } from "../lib/campaignDayStats.js";
import {
  freshBounceSamples,
  shouldPauseCampaignForBounceBurst,
  type BouncePauseReason,
} from "../lib/campaignBouncePause.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  buildIsolationAction,
  domainRecentlyRetired,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { sleep } from "../lib/http.js";
import { BounceResurrectionService } from "./bounceResurrection.js";
import type { BounceVerdictRecord } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;
const ANALYTICS_START = "2020-01-01";
/**
 * D148 — while an incident is open, repeat bursts inside this window fold
 * into it silently (no re-classify, no repeat Slack): a capped tenant
 * keeps bouncing every tick until midnight and one receipt an hour is
 * signal, six a hour is noise.
 */
const BURST_REALERT_MS = 60 * 60 * 1000;
/** The bounced-rows ledger can lag the counter — wait this long between reads. */
const SAMPLE_RETRY_MS = process.env.NODE_TEST_CONTEXT ? 0 : 90 * 1000;
const SAMPLE_ATTEMPTS = 3;
const SAMPLE_PAGE = 15;
/** D162 — message-history reads for the burst-independent 5.1.8 scan. */
const SENDER_BLOCK_READS_PER_TICK = 16;
const SENDER_BLOCK_SAMPLE_ATTEMPTS = 1;

/** COMPLETED / STOPPED campaigns never send again — stop touching them. */
export function isTerminalCampaignStatus(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "COMPLETED" || s === "STOPPED";
}

/** ACTIVE or PAUSED — D162 still samples 5.1.8s after a Smartlead autopause. */
export function isLivingSendCampaign(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "PAUSED";
}

/** D157 — Smartlead bounce-protection pause on the LIST /campaigns payload. */
export function pausedByBounceProtection(campaign: SmartleadCampaign): boolean {
  const logs = campaign.campaign_activity_logs;
  if (!Array.isArray(logs)) return false;
  return logs.some((log) =>
    /bounce protection/i.test(String(log?.paused_reason ?? "")),
  );
}

export interface BounceBurstFinding {
  campaignId: number;
  campaignName: string;
  sent: number;
  bounces: number;
  bounceRate: number;
  reason: BouncePauseReason;
  burstBounces?: number;
  verdict?: BounceVerdictRecord;
}

export interface CampaignBounceAutostopResult {
  dryRun: boolean;
  scanned: number;
  /** Real fresh bursts found this tick — investigated, never paused (D148). */
  bursts: BounceBurstFinding[];
  skipped: number;
  /** Burst trips that turned out to be ledger dumps of stale bounces (D141). */
  ledgerDumps: number;
  /** D147/D148 — incident leads re-queued for a resend this tick. */
  resurrected?: number;
  /** D162 — burned-domain retire asks opened from a 5.1.8 sample this tick. */
  senderBlockAsks: number;
  errors: string[];
}

function lifetimeStart(campaign: SmartleadCampaign): string {
  const created = campaign.created_at;
  if (!created) return ANALYTICS_START;
  const parsed = new Date(created);
  if (!Number.isFinite(parsed.getTime())) return ANALYTICS_START;
  return ymdUtc(parsed);
}

function mergeSendBounce(...payloads: unknown[]): {
  sent: number;
  bounces: number;
  bounceRate: number;
} {
  let best = { sent: 0, bounces: 0, bounceRate: 0 };
  for (const payload of payloads) {
    const row = statsFromAnalytics(payload);
    if (row.sent > best.sent) {
      best = { sent: row.sent, bounces: row.bounces, bounceRate: row.bounceRate };
    }
  }
  return best;
}

/**
 * D141/D148 — a REAL bounce burst (more than 10 new bounces in the last
 * 10 minutes whose sampled sends actually happened inside the last 24h)
 * is investigated, remediated and re-queued — NEVER paused. Josh: "i
 * dont want anything paused anymore — we should be investigating,
 * remediating and readding." A burst classifies the sampled SMTP reasons
 * (D140), Slacks one receipt naming the verdict and the plan, routes the
 * remediation (tenant-cap page D140, retire ask D146, bad-list callout),
 * and opens a resurrection incident when the verdict blames the sender
 * (D147/D148) — repeat bursts inside the hour fold into the open
 * incident silently. Smartlead's ledger batch-records old bounces days
 * late, so a tripped counter first samples the bounced rows (retrying
 * while the ledger lags) — a dump of stale bounces logs loudly and does
 * nothing. The D90 lifetime-rate rule (>10% after 1k) stays retired.
 * Does not START anyone (D40) and does not pause anyone (D148) — pauses
 * belong to humans in both directions. It also writes no Smartlead
 * settings: `bounce_autopause_threshold` is dead on the public API — the
 * settings handler validates it and then discards it, so High Bounce
 * Rate Auto Protection can only be turned off in the UI (D157).
 * D162 — a `550 5.1.8` / AS(42004) sample opens the burned-domain retire
 * ask even when there is no burst and even when the campaign is PAUSED
 * (Smartlead's UI bounce protection). That scan is not a D91 rate hunt.
 */
export class CampaignBounceAutostopService {
  private readonly resurrection?: BounceResurrectionService;
  private isolation?: {
    queueContentBlockSuspect(campaignId: number): Promise<void>;
  };

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state?: StateStore,
    private readonly slack?: Pick<SlackClient, "send" | "notifyIsolationAction">,
    resurrection?: BounceResurrectionService,
    private readonly clock: () => number = Date.now,
  ) {
    this.resurrection =
      resurrection ??
      (state
        ? new BounceResurrectionService(config, smartlead, state, slack, clock)
        : undefined);
  }

  /** Wired after IsolationBranchService is constructed (index.ts order). */
  setIsolationBranch(isolation: {
    queueContentBlockSuspect(campaignId: number): Promise<void>;
  }): void {
    this.isolation = isolation;
  }

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignBounceAutostopResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignBounceAutostopResult = {
      dryRun,
      scanned: 0,
      bursts: [],
      skipped: 0,
      ledgerDumps: 0,
      senderBlockAsks: 0,
      errors: [],
    };
    if (!this.config.enableCampaignBounceAutostop) {
      console.log("[bounce-autostop] Disabled");
      return result;
    }

    let campaigns: SmartleadCampaign[];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list campaigns: ${message}`);
      return result;
    }

    const nowMs = this.clock();
    const end = ymdUtc(new Date(nowMs));
    const nowIso = new Date(nowMs).toISOString();
    const living = campaigns.filter((campaign) => {
      if (isAnyShellCampaign(campaign, this.config.podControlShellCampaignId)) {
        return false;
      }
      return isLivingSendCampaign(campaign.status);
    });
    const active = living.filter(
      (campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE",
    );
    const paused = living
      .filter(
        (campaign) => String(campaign.status ?? "").toUpperCase() === "PAUSED",
      )
      .sort(
        (a, b) =>
          Number(pausedByBounceProtection(b)) - Number(pausedByBounceProtection(a)),
      );
    const classifiedBurst = new Set<number>();
    const needsSenderBlock = new Set<number>();

    for (const campaign of active) {
      result.scanned += 1;
      // Pre-D148 transition: deploys before D148 stamped their pauses.
      // ACTIVE with a stamp means a human STARTed one of those campaigns —
      // the stored verdict still owes its resend (D147), so the incident
      // opens here, right before the stamp drains. New code never stamps.
      if (this.state?.isBouncePaused?.(campaign.id)) {
        try {
          this.resurrection?.noteRestart({
            id: campaign.id,
            name: String(campaign.name ?? campaign.id),
          });
        } catch (error) {
          console.warn(
            `[bounce-resurrect] noteRestart #${campaign.id} failed`,
            error,
          );
        }
      }
      this.state?.clearBouncePaused(campaign.id);
      try {
        const analytics = await this.smartlead
          .getCampaignAnalyticsByDate(campaign.id, lifetimeStart(campaign), end)
          .catch(() => null);
        const statistics =
          statsFromAnalytics(analytics).sent > 0
            ? null
            : await this.smartlead
                .getCampaignStatistics(campaign.id)
                .catch(() => null);
        const { sent, bounces, bounceRate } = mergeSendBounce(analytics, statistics);
        const previous = this.state?.getBounceSnapshot(campaign.id);
        const burst = shouldPauseCampaignForBounceBurst(
          previous,
          bounces,
          nowMs,
          this.config.bounceBurstCount,
        );

        if (!burst.trip) {
          if (!previous?.senderBlockHint || bounces > previous.bounced) {
            needsSenderBlock.add(campaign.id);
          }
          this.state?.setBounceSnapshot(campaign.id, {
            bounced: bounces,
            sent,
            at: nowIso,
            senderBlockHint: previous?.senderBlockHint,
          });
          result.skipped += 1;
          continue;
        }

        // D148 — while this campaign's incident is open and recently
        // reported, a re-trip is the same wave still burning: consume the
        // delta, widen the incident window, stay quiet. One receipt an
        // hour is signal; one every tick is noise.
        const openJob = this.state?.getBounceResurrectionJob?.(campaign.id);
        if (
          openJob &&
          !openJob.done &&
          nowMs - Date.parse(openJob.lastBurstAt) < BURST_REALERT_MS
        ) {
          this.state?.setBounceSnapshot(campaign.id, {
            bounced: bounces,
            sent,
            at: nowIso,
            senderBlockHint: previous?.senderBlockHint,
          });
          if (!dryRun) this.resurrection?.extendIncident(campaign.id);
          console.log(
            `[bounce-autostop] burst on #${campaign.id} ${campaign.name} folded into the open incident (+${burst.delta} in 10m; D148)`,
          );
          result.skipped += 1;
          continue;
        }

        // D141 — a tripped counter is a suspicion, not a verdict. Sample
        // the bounced rows first: only sends that actually happened in the
        // last 24h count as a live burst; a ledger dump of stale bounces
        // never pauses anyone.
        const rows = await this.sampleBouncedRows(campaign.id);
        if (rows == null) {
          // Rows unreadable while the ledger lags: keep the previous
          // snapshot so the delta re-evaluates (and re-samples) next tick
          // instead of being silently consumed.
          console.warn(
            `[bounce-autostop] burst on #${campaign.id} ${campaign.name}: +${burst.delta} in 10m but bounced rows unreadable — no pause, re-checking next tick (D141)`,
          );
          result.skipped += 1;
          continue;
        }

        const recency = freshBounceSamples(rows, nowMs);
        this.state?.setBounceSnapshot(campaign.id, {
          bounced: bounces,
          sent,
          at: nowIso,
          senderBlockHint:
            recency.fresh === 0
              ? previous?.senderBlockHint
              : (previous?.senderBlockHint ?? senderBlockScanHint(rows)),
        });

        if (recency.fresh === 0) {
          needsSenderBlock.add(campaign.id);
          result.ledgerDumps += 1;
          console.log(
            `[bounce-autostop] burst on #${campaign.id} ${campaign.name} is a ledger dump: +${burst.delta} recorded in 10m, ${recency.readable} rows sampled, newest send ${recency.newestSentAt ?? "unknown"}, none inside 24h — no pause (D141)`,
          );
          result.skipped += 1;
          continue;
        }

        const finding: BounceBurstFinding = {
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          sent,
          bounces,
          bounceRate,
          reason: "burst" satisfies BouncePauseReason,
          burstBounces: burst.delta,
        };
        console.log(
          `[bounce-autostop] BURST #${finding.campaignId} ${finding.campaignName} burst=${finding.burstBounces} new bounces in 10m (${recency.fresh} sampled sends <24h old) sent=${sent} — investigating, not pausing (D148)${dryRun ? " (dry-run)" : ""}`,
        );
        result.bursts.push(finding);
        // D140 — a bounce count is a symptom; read the actual SMTP reasons
        // before anyone blames the list. Diagnosis failure never kills the scan.
        try {
          finding.verdict = await this.classifyRecentBounces(
            campaign.id,
            dryRun,
            rows,
          );
          classifiedBurst.add(campaign.id);
        } catch (error) {
          console.warn(
            `[bounce-autostop] verdict #${campaign.id} unreadable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // D148 — the verdict decides the plan: a sender-fault incident
        // opens (its leads re-queue as each remediation lands); a bad
        // list is Josh's call and re-queues nothing.
        if (!dryRun && finding.verdict) {
          this.resurrection?.noteIncident(
            { id: campaign.id, name: finding.campaignName },
            finding.verdict,
          );
        }
        // D158 — dominant content_block is a copy-suspect flag, same as
        // an ugly canary. Isolation decides COPY vs INFRA; bounce still
        // never pauses (D148).
        if (
          !dryRun &&
          finding.verdict?.dominant === "content_block" &&
          this.isolation
        ) {
          try {
            await this.isolation.queueContentBlockSuspect(campaign.id);
          } catch (error) {
            console.warn(
              `[bounce-autostop] content_block isolation queue #${campaign.id} failed`,
              error,
            );
          }
        }
        if (!dryRun && this.slack) {
          try {
            await this.slack.send(
              burstReceiptText(finding),
              undefined,
              "action_result",
            );
          } catch (error) {
            console.warn("[bounce-autostop] burst receipt failed", error);
          }
        }
        await sleep(WRITE_GAP_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
      }
    }

    // D162 — ANY 5.1.8 / AS(42004) sample opens the retire ask, including
    // PAUSED campaigns Smartlead already bounce-protection paused, and
    // ACTIVE campaigns whose drip never tripped the >10/10-min burst.
    // Not a D91 bounce-rate hunt: only the sender-block SMTP class acts.
    let senderBlockReadsLeft = SENDER_BLOCK_READS_PER_TICK;
    const senderBlockQueue = [
      ...paused,
      ...active.filter(
        (campaign) =>
          !classifiedBurst.has(campaign.id) && needsSenderBlock.has(campaign.id),
      ),
    ];
    for (const campaign of senderBlockQueue) {
      if (senderBlockReadsLeft <= 0) break;
      if (String(campaign.status ?? "").toUpperCase() === "PAUSED") {
        result.scanned += 1;
      }
      try {
        const used = await this.scanSenderBlockedNdRs(
          campaign,
          dryRun,
          senderBlockReadsLeft,
        );
        senderBlockReadsLeft -= used.reads;
        result.senderBlockAsks += used.asksOpened;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} sender-block: ${message}`);
      }
    }

    // D157 — no Smartlead autopause write happens here, because none is
    // possible. POST /campaigns/{id}/settings schema-validates
    // `bounce_autopause_threshold` ("must be a string"; unknown keys 400)
    // and the handler then DISCARDS it: a "banana" write returns ok:true
    // and the UI keeps its value. Proven live 2026-08-31 — a Peterson
    // campaign still showed 7% in the UI after "100" and null fleet
    // writes that all returned ok. High Bounce Rate Auto Protection is
    // UI-only; the pause attribution surface is
    // `campaign_activity_logs.paused_reason: "bounce protection"` on GET
    // /campaigns, and the only off-switch is the campaign SETUP page.
    // Three generations of API "off" writes (D80 converge, D124 force,
    // D155 null) were no-ops and are deleted.

    if (!dryRun) {
      await this.state?.save();
    }

    // D147/D148 — work the open resurrection jobs (rate-budgeted; a
    // failure here must never break the bounce loop).
    if (!dryRun && this.resurrection) {
      try {
        const revived = await this.resurrection.work();
        result.resurrected = revived.requeued;
        for (const message of revived.errors) {
          result.errors.push(`resurrect ${message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`resurrect: ${message}`);
      }
    }

    console.log(
      `[bounce-autostop] scanned=${result.scanned} bursts=${result.bursts.length} skipped=${result.skipped} senderBlockAsks=${result.senderBlockAsks} errors=${result.errors.length}`,
    );
    if (result.errors.length) {
      // A counted-but-nameless error hid a stuck per-campaign write on
      // 2026-08-31 — say which campaign and why, like the other loops do.
      console.warn(
        `[bounce-autostop] errors ${result.errors.slice(0, 5).join(" | ")}${result.errors.length > 5 ? ` | … and ${result.errors.length - 5} more` : ""}`,
      );
    }
    return result;
  }

  /**
   * D141 — fetch bounced-send rows for the recency gate, retrying while
   * the analytics ledger lags the counter (the D140 first run read the
   * ledger the same second the pause fired and saw nothing; the rows were
   * there minutes later). Row ordering is unspecified, so read both ends:
   * the first page and, when the total is bigger, the last page. Returns
   * null when no rows are readable after every attempt.
   */
  private async sampleBouncedRows(
    campaignId: number,
    attempts = SAMPLE_ATTEMPTS,
  ): Promise<Array<Record<string, unknown>> | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(SAMPLE_RETRY_MS);
      try {
        const first = (await this.smartlead.listBouncedSendStats(
          campaignId,
          SAMPLE_PAGE,
        )) as { total_stats?: unknown; data?: unknown[] };
        const rows = Array.isArray(first?.data)
          ? ([...first.data] as Array<Record<string, unknown>>)
          : [];
        const total = Number(first?.total_stats ?? rows.length);
        if (Number.isFinite(total) && total > SAMPLE_PAGE) {
          await sleep(WRITE_GAP_MS);
          const last = (await this.smartlead.listBouncedSendStats(
            campaignId,
            SAMPLE_PAGE,
            Math.max(0, Math.floor(total) - SAMPLE_PAGE),
          )) as { data?: unknown[] };
          if (Array.isArray(last?.data)) {
            rows.push(...(last.data as Array<Record<string, unknown>>));
          }
        }
        if (rows.length) return rows;
      } catch {
        // transient read failure — retry on the next attempt
      }
    }
    return null;
  }

  /**
   * D140 — sample the campaign's bounced sends, read each NDR's SMTP
   * reason, classify, remember, and — for a Microsoft tenant hitting its
   * daily external-recipient cap — Slack once per tenant per day. A
   * content-block verdict is recorded for the canary-diagnosis follow-up;
   * an invalid-recipient wave points at the list. Rows come from the D141
   * recency sample so the ledger is read once per pause.
   */
  private async classifyRecentBounces(
    campaignId: number,
    dryRun: boolean,
    rows: Array<Record<string, unknown>>,
  ): Promise<BounceVerdictRecord | undefined> {
    const samples = await this.collectNdrSamples(campaignId, rows, 4);
    const { dominant, summary } = summarizeBounceSamples(samples);
    const senderDomains = sampleSenderDomains(samples);
    const record: BounceVerdictRecord = {
      campaignId,
      at: new Date().toISOString(),
      dominant,
      summary,
      senderDomains,
    };
    this.state?.setBounceVerdict(record);
    console.log(
      `[bounce-autostop] verdict #${campaignId}: ${summary}${senderDomains.length ? ` senders=${senderDomains.join(",")}` : ""}${samples[0] ? ` e.g. "${samples[0].snippet.slice(0, 120)}"` : ""}`,
    );
    if (
      dominant === "tenant_rate_limit" &&
      !dryRun &&
      this.slack &&
      this.state
    ) {
      const day = new Date().toISOString().slice(0, 10);
      for (const domain of senderDomains) {
        const key = `tenant-limit:${domain}:${day}`;
        if (this.state.hasAlert(key)) continue;
        this.state.markAlert(key);
        await this.slack.send(
          [
            `*${domain} hit its Microsoft daily sending cap.*`,
            `Every send from that tenant is bouncing with 550 5.7.233 (tenant external recipient rate limit) — first seen on campaign #${campaignId}. The lists are fine; the tenant is out of allowance until the cap resets.`,
            "Fix options: fewer sending mailboxes on that tenant, lower per-mailbox daily caps, split the fleet across tenants, or add licenses.",
          ].join("\n"),
          undefined,
          "burned_domain",
        );
      }
    }
    // D145/D146/D162 — ANY sender_blocked sample opens the retire ask,
    // never dominant-gated, never burst-gated. Same helper the
    // independent PAUSED/slow-drip scan uses.
    await this.openSenderBlockedRetireAsks(campaignId, samples, dryRun);
    return record;
  }

  /**
   * D162 — look for a 5.1.8 / AS(42004) NDR without waiting for a burst
   * or an ACTIVE status. Stats have no SMTP text; message-history does.
   * Returns how many history reads were spent and how many asks opened.
   */
  private async scanSenderBlockedNdRs(
    campaign: SmartleadCampaign,
    dryRun: boolean,
    readsLeft: number,
  ): Promise<{ reads: number; asksOpened: number }> {
    if (readsLeft <= 0) return { reads: 0, asksOpened: 0 };
    const previous = this.state?.getBounceSnapshot(campaign.id);
    const rows =
      (await this.sampleBouncedRows(campaign.id, SENDER_BLOCK_SAMPLE_ATTEMPTS)) ??
      (await this.senderOriginatedLeadRows(campaign.id));
    if (!rows?.length) return { reads: 0, asksOpened: 0 };
    const hint = senderBlockScanHint(rows);
    if (previous?.senderBlockHint === hint) return { reads: 0, asksOpened: 0 };

    const samples = await this.collectNdrSamples(campaign.id, rows, readsLeft);
    const asksOpened = await this.openSenderBlockedRetireAsks(
      campaign.id,
      samples,
      dryRun,
    );
    this.state?.setBounceSnapshot(campaign.id, {
      bounced: previous?.bounced ?? rows.length,
      sent: previous?.sent ?? 0,
      at: previous?.at ?? new Date(this.clock()).toISOString(),
      senderBlockHint: hint,
    });
    return { reads: Math.min(readsLeft, preferNdrRows(rows).length), asksOpened };
  }

  /**
   * Fallback when bounced-stats are empty: one page of campaign leads,
   * keeping Sender Originated Bounce / unset categories (D162).
   */
  private async senderOriginatedLeadRows(
    campaignId: number,
  ): Promise<Array<Record<string, unknown>> | null> {
    if (typeof this.smartlead.getCampaignLeads !== "function") return null;
    try {
      const page = (await this.smartlead.getCampaignLeads(campaignId, {
        limit: 25,
      })) as {
        data?: Array<Record<string, unknown>>;
        leads?: Array<Record<string, unknown>>;
      };
      const data = Array.isArray(page?.data)
        ? page.data
        : Array.isArray(page?.leads)
          ? page.leads
          : [];
      const rows: Array<Record<string, unknown>> = [];
      for (const row of data) {
        const nested =
          row.lead && typeof row.lead === "object" && !Array.isArray(row.lead)
            ? (row.lead as Record<string, unknown>)
            : undefined;
        const email = String(row.lead_email ?? nested?.email ?? row.email ?? "").trim();
        if (!email) continue;
        rows.push({
          lead_email: email,
          lead_id: nested?.id ?? row.lead_id ?? row.id,
          sent_time: row.sent_time ?? row.last_sent_time ?? nested?.last_sent_time,
          lead_category: leadCategoryOf(row),
        });
      }
      const preferred = preferNdrRows(rows);
      return preferred.length ? preferred : null;
    } catch {
      return null;
    }
  }

  /**
   * D140/D162 — read message-history NDRs. Prefer Sender Originated
   * Bounce / unset lead_category (stats have no SMTP).
   */
  private async collectNdrSamples(
    campaignId: number,
    rows: Array<Record<string, unknown>>,
    limit: number,
  ): Promise<BounceSample[]> {
    const samples: BounceSample[] = [];
    const byRecency = [...preferNdrRows(rows)].sort(
      (a, b) =>
        (Date.parse(String(b.sent_time ?? b.last_sent_time ?? "")) || 0) -
        (Date.parse(String(a.sent_time ?? a.last_sent_time ?? "")) || 0),
    );
    for (const row of byRecency.slice(0, Math.max(0, limit))) {
      const leadEmail = String(row.lead_email ?? "");
      if (!leadEmail) continue;
      try {
        let leadId = row.lead_id ?? row.id;
        if (leadId == null || leadId === "") {
          const lead = (await this.smartlead.fetchLeadByEmail(leadEmail)) as {
            id?: number | string;
          };
          leadId = lead?.id;
        }
        if (leadId == null || leadId === "") continue;
        await sleep(120);
        const history = await this.smartlead.getLeadMessageHistory(
          campaignId,
          leadId as number | string,
        );
        await sleep(120);
        const entries = Array.isArray(
          (history as { history?: unknown[] } | null)?.history,
        )
          ? ((history as { history: Array<Record<string, unknown>> }).history ?? [])
          : [];
        const sent = entries.find(
          (entry) => String(entry.type ?? "").toUpperCase() === "SENT",
        );
        const ndrBody = ndrBodyFromHistory(history);
        if (!ndrBody) continue;
        const snippet = bounceReasonSnippet(ndrBody);
        samples.push({
          leadEmail,
          senderEmail: sent ? String(sent.from ?? "") || null : null,
          bounceClass: classifyBounceText(snippet + " " + ndrBody),
          snippet,
        });
      } catch {
        // one unreadable lead must not kill the verdict
      }
    }
    return samples;
  }

  /**
   * D145/D146/D162 — ANY sender_blocked sample opens the standard
   * burned-domain retire ask (receipts + buttons). Pending ask is the
   * dedupe (one per domain). Slack kind is burned_domain (D71).
   */
  private async openSenderBlockedRetireAsks(
    campaignId: number,
    samples: BounceSample[],
    dryRun: boolean,
  ): Promise<number> {
    if (dryRun || !this.slack || !this.state) return 0;
    const store = this.state;
    const slack = this.slack;
    const blockedByDomain = new Map<string, Set<string>>();
    for (const sample of samples) {
      if (sample.bounceClass !== "sender_blocked" || !sample.senderEmail) {
        continue;
      }
      const sender = sample.senderEmail.toLowerCase();
      const domain = sender.split("@")[1];
      if (!domain) continue;
      const set = blockedByDomain.get(domain) ?? new Set<string>();
      set.add(sender);
      blockedByDomain.set(domain, set);
    }
    let openedCount = 0;
    for (const [domain, senders] of blockedByDomain) {
      if (domainRecentlyRetired(store, domain)) continue;
      const snippet =
        samples.find(
          (sample) =>
            sample.bounceClass === "sender_blocked" &&
            sample.senderEmail?.toLowerCase().split("@")[1] === domain,
        )?.snippet ?? "550 5.1.8 bad outbound sender";
      const opened = await requestIsolationAction({
        store,
        slack,
        action: buildIsolationAction({
          kind: "retire_domain",
          title: `Retire ${domain} — Microsoft flagged it as a bad outbound sender`,
          proof: [
            `Microsoft's outbound spam filter blocked ${[...senders]
              .map((sender) => `\`${sender}\``)
              .join(", ")} (550 5.1.8) — first seen on campaign #${campaignId}.`,
            `"${snippet.slice(0, 160)}"`,
            "The block does not reset at midnight — the account sits in Defender's Restricted entities until unblocked. Cancel retires nothing; unblock the sender in Defender instead.",
          ].join("\n"),
          detail: { domain },
        }),
      });
      if (opened) {
        openedCount += 1;
        console.log(
          `[bounce-autostop] burned-domain ask opened for ${domain} — sender blocked (D146/D162)`,
        );
      }
    }
    return openedCount;
  }

}

/**
 * D148 — the burst receipt IS the investigation Josh asked for: what
 * bounced, why, and what happens next. One per incident per hour.
 */
export function burstReceiptText(finding: BounceBurstFinding): string {
  const lines = [
    `*Bounce burst on ${finding.campaignName} — ${finding.burstBounces ?? finding.bounces} new bounces in 10 minutes.*`,
  ];
  const verdict = finding.verdict;
  if (!verdict || verdict.dominant == null) {
    lines.push(
      "Bounce reasons unreadable this tick — the loop keeps sampling. Nothing pauses (D148); the campaign keeps sending.",
    );
    return lines.join("\n");
  }
  lines.push(
    `Verdict: ${verdict.summary}${verdict.senderDomains.length ? ` — senders ${verdict.senderDomains.join(", ")}` : ""}`,
  );
  const plans: Record<string, string> = {
    tenant_rate_limit:
      "The tenant's Microsoft daily allowance is exhausted. The capped leads re-queue automatically once it resets at midnight UTC; real bad addresses stay dead.",
    sender_blocked:
      "Microsoft flagged the sender for outbound spam — the domain's retire ask is open in this channel. Its leads re-queue once you resolve it (Retire, or unblock in Defender and Cancel).",
    content_block:
      "Microsoft is blocking the message content. Edit the campaign's copy and the bounced leads re-queue on their own.",
    invalid_recipient:
      "These look like real bad addresses — nothing gets re-queued. The list source needs a look.",
  };
  lines.push(
    plans[verdict.dominant] ??
      "Investigating — each lead's own bounce reason decides whether it re-queues.",
  );
  lines.push(
    "Nothing pauses (D148) — the campaign keeps sending while the incident works itself off.",
  );
  return lines.join("\n");
}
