import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import {
  bounceReasonSnippet,
  classifyBounceText,
  sampleSenderDomains,
  summarizeBounceSamples,
  type BounceSample,
} from "../lib/bounceReason.js";
import { statsFromAnalytics, ymdUtc } from "../lib/campaignDayStats.js";
import { SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT } from "../lib/campaignBounceAutostop.js";
import {
  freshBounceSamples,
  shouldPauseCampaignForBounceBurst,
  type BouncePauseReason,
} from "../lib/campaignBouncePause.js";
import {
  campaignSettingsWriteBody,
  readBounceAutopausePercent,
} from "../lib/bounceAutopause.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { sleep } from "../lib/http.js";
import { BounceResurrectionService } from "./bounceResurrection.js";
import type { BounceVerdictRecord } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 350;
const ANALYTICS_START = "2020-01-01";
/** Read-verify the off threshold this often; the 10m loop only fills gaps. */
const AUTOPAUSE_VERIFY_EVERY_MS = 6 * 60 * 60 * 1000;
/** The bounced-rows ledger can lag the counter — wait this long between reads. */
const SAMPLE_RETRY_MS = process.env.NODE_TEST_CONTEXT ? 0 : 90 * 1000;
const SAMPLE_ATTEMPTS = 3;
const SAMPLE_PAGE = 15;

/** COMPLETED / STOPPED campaigns never send again — stop touching them. */
export function isTerminalCampaignStatus(status: unknown): boolean {
  const s = String(status ?? "").toUpperCase();
  return s === "COMPLETED" || s === "STOPPED";
}

export interface BounceAutostopPause {
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
  paused: BounceAutostopPause[];
  skipped: number;
  /** Burst trips that turned out to be ledger dumps of stale bounces (D141). */
  ledgerDumps: number;
  smartleadDisabled: number;
  /** D147 — incident leads re-queued for a resend this tick. */
  resurrected?: number;
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
 * D141 — pause ACTIVE campaigns only on a REAL bounce burst: more than 10
 * new bounces in the last 10 minutes whose sampled sends actually happened
 * inside the last 24h. Smartlead's ledger batch-records old bounces days
 * late, so a tripped counter first samples the bounced rows (retrying
 * while the ledger lags) — a dump of stale bounces logs loudly and never
 * pauses. The D90 lifetime-rate rule (>10% after 1k) is retired: verified
 * lists never bounce like that, so it only ever fired on artifacts. Does
 * not START anyone (D40). D88's 20/7 bands stay retired; D91 retired the
 * paused-campaign hunt. After the scan, Smartlead
 * bounce_autopause_threshold is converged to 100 (off). A pause is
 * stamped (D128) so qa-unpause never fights it — only a human STARTs a
 * bounce-paused campaign. A real pause classifies the sampled SMTP
 * reasons (D140).
 */
export class CampaignBounceAutostopService {
  private readonly resurrection?: BounceResurrectionService;

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state?: StateStore,
    private readonly slack?: Pick<SlackClient, "send" | "notifyIsolationAction">,
    resurrection?: BounceResurrectionService,
  ) {
    this.resurrection =
      resurrection ??
      (state
        ? new BounceResurrectionService(config, smartlead, state, slack)
        : undefined);
  }

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignBounceAutostopResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignBounceAutostopResult = {
      dryRun,
      scanned: 0,
      paused: [],
      skipped: 0,
      ledgerDumps: 0,
      smartleadDisabled: 0,
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

    const end = ymdUtc(new Date());
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const active = campaigns.filter((campaign) => {
      if (isAnyShellCampaign(campaign, this.config.podControlShellCampaignId)) {
        return false;
      }
      return String(campaign.status ?? "").toUpperCase() === "ACTIVE";
    });

    for (const campaign of active) {
      result.scanned += 1;
      // ACTIVE means any earlier bounce pause was resolved by a human
      // START — the stamp has served its purpose (D128). D147: that START
      // is also the remediation signal, so the resurrection job opens
      // here, before the stamp clears.
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
          this.state?.setBounceSnapshot(campaign.id, {
            bounced: bounces,
            sent,
            at: nowIso,
          });
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
        });

        if (recency.fresh === 0) {
          result.ledgerDumps += 1;
          console.log(
            `[bounce-autostop] burst on #${campaign.id} ${campaign.name} is a ledger dump: +${burst.delta} recorded in 10m, ${recency.readable} rows sampled, newest send ${recency.newestSentAt ?? "unknown"}, none inside 24h — no pause (D141)`,
          );
          result.skipped += 1;
          continue;
        }

        const finding: BounceAutostopPause = {
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          sent,
          bounces,
          bounceRate,
          reason: "burst" satisfies BouncePauseReason,
          burstBounces: burst.delta,
        };
        console.log(
          `[bounce-autostop] PAUSE #${finding.campaignId} ${finding.campaignName} burst=${finding.burstBounces} new bounces in 10m (${recency.fresh} sampled sends <24h old) sent=${sent}${dryRun ? " (dry-run)" : ""}`,
        );
        if (!dryRun) {
          await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
          // D128 — stamp the pause so qa-unpause cannot START it back up;
          // a bounce pause waits for a human (D141/D40).
          this.state?.markBouncePaused(campaign.id, nowIso);
        }
        result.paused.push(finding);
        // D140 — a bounce count is a symptom; read the actual SMTP reasons
        // before anyone blames the list. Never let diagnosis break the pause.
        try {
          finding.verdict = await this.classifyRecentBounces(
            campaign.id,
            dryRun,
            rows,
          );
        } catch (error) {
          console.warn(
            `[bounce-autostop] verdict #${campaign.id} unreadable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(WRITE_GAP_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
      }
    }

    if (this.config.enableBounceAutopauseConverge) {
      await this.disableSmartleadAutopause(campaigns, dryRun, result);
    }

    if (!dryRun) {
      await this.state?.save();
    }

    // D147 — work the open resurrection jobs (rate-budgeted; a failure
    // here must never break the bounce loop).
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
      `[bounce-autostop] scanned=${result.scanned} paused=${result.paused.length} skipped=${result.skipped} smartleadOff=${result.smartleadDisabled} errors=${result.errors.length}`,
    );
    return result;
  }

  /**
   * D84 — converge on drift, not on schedule. The 10-minute loop writes only
   * campaigns we have never converged (new ids). Every 6h one read-verify
   * sweep checks living campaigns and rewrites only actual drift, so a
   * UI-side change still gets caught without ~600 blind writes/hour.
   *
   * D124 — until `autopauseForceAllAt` is stamped, write 100 on every living
   * campaign even when the cache and GET already say 100. A threshold-only
   * POST has already disagreed with the Smartlead UI toggle; GET-echo the
   * other settings so the write actually lands.
   */
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
  ): Promise<Array<Record<string, unknown>> | null> {
    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt += 1) {
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
    const samples: BounceSample[] = [];
    const byRecency = [...rows].sort(
      (a, b) =>
        (Date.parse(String(b.sent_time ?? "")) || 0) -
        (Date.parse(String(a.sent_time ?? "")) || 0),
    );
    for (const row of byRecency.slice(0, 4)) {
      const leadEmail = String(row.lead_email ?? "");
      if (!leadEmail) continue;
      try {
        const lead = (await this.smartlead.fetchLeadByEmail(leadEmail)) as {
          id?: number | string;
        };
        if (lead?.id == null) continue;
        await sleep(120);
        const history = (await this.smartlead.getLeadMessageHistory(
          campaignId,
          lead.id,
        )) as { history?: Array<Record<string, unknown>> };
        await sleep(120);
        const sent = (history?.history ?? []).find(
          (entry) => String(entry.type ?? "").toUpperCase() === "SENT",
        );
        const ndr = (history?.history ?? []).find(
          (entry) =>
            String(entry.type ?? "").toUpperCase() === "REPLY" &&
            /delivery has failed|mail delivery|undeliverable|returned/i.test(
              String(entry.email_body ?? ""),
            ),
        );
        if (!ndr) continue;
        const snippet = bounceReasonSnippet(String(ndr.email_body ?? ""));
        samples.push({
          leadEmail,
          senderEmail: sent ? String(sent.from ?? "") || null : null,
          bounceClass: classifyBounceText(snippet + " " + String(ndr.email_body ?? "")),
          snippet,
        });
      } catch {
        // one unreadable lead must not kill the verdict
      }
    }
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
    // D145/D146 — a 5.1.8 "bad outbound sender" is Microsoft flagging a
    // mailbox for outbound spam. Josh: "that bad outbound sender should
    // just trigger a burned domain" — the domain goes straight into the
    // standard burned-domain flow (receipts + retire button; the tap is
    // the approval, D49/D134), not a plain FYI page. Never gated on being
    // the dominant class: the 8/27 live block was a minority sample under
    // a tenant-cap wave. One pending ask per domain (samePending); the
    // block itself never resets on its own.
    if (!dryRun && this.slack && this.state) {
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
      for (const [domain, senders] of blockedByDomain) {
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
          console.log(
            `[bounce-autostop] burned-domain ask opened for ${domain} — sender blocked (D146)`,
          );
        }
      }
    }
    return record;
  }

  private async disableSmartleadAutopause(
    campaigns: SmartleadCampaign[],
    dryRun: boolean,
    result: CampaignBounceAutostopResult,
  ): Promise<void> {
    const off = String(
      this.config.smartleadBounceAutopauseOffPercent ??
        SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT,
    );
    const offNumber = Number(off);
    const living = campaigns.filter(
      (campaign) =>
        !isAnyShellCampaign(campaign, this.config.podControlShellCampaignId) &&
        !isTerminalCampaignStatus(campaign.status),
    );

    const lastVerify = this.state?.getLastAutopauseVerifyAt();
    const verifyDue =
      !lastVerify ||
      Date.now() - Date.parse(lastVerify) >= AUTOPAUSE_VERIFY_EVERY_MS;
    const forceAll = !this.state?.getAutopauseForceAllAt();

    let disableErrors = 0;
    for (const campaign of living) {
      const alreadyOff = this.state?.getAutopauseOffAt(campaign.id);
      if (!forceAll && alreadyOff && !verifyDue) continue;
      try {
        // GET /campaigns/{id}/settings 404s on this Smartlead account.
        // Only spend a read on the 6h verify; force/first write is POST-only.
        let settings: unknown = null;
        if (!forceAll && alreadyOff && verifyDue) {
          settings = await this.smartlead
            .getCampaignSettings(campaign.id)
            .catch(() => null);
          await sleep(120);
          const current = readBounceAutopausePercent(settings);
          if (current == null || current === offNumber) continue;
          console.log(
            `[bounce-autostop] drift on #${campaign.id} ${campaign.name}: autopause ${current}% → ${off}%${dryRun ? " (dry-run)" : ""}`,
          );
        } else if (forceAll) {
          console.log(
            `[bounce-autostop] force autopause off #${campaign.id} ${campaign.name} → ${off}%${dryRun ? " (dry-run)" : ""}`,
          );
        } else {
          console.log(
            `[bounce-autostop] Smartlead autopause off ${campaign.name} #${campaign.id} → ${off}%${dryRun ? " (dry-run)" : ""}`,
          );
        }
        if (!dryRun) {
          const body = campaignSettingsWriteBody(settings ?? {}, {
            bounce_autopause_threshold: off,
          });
          await this.smartlead.updateCampaignSettings(campaign.id, body);
          await sleep(WRITE_GAP_MS);
          this.state?.markAutopauseOff(campaign.id);
        }
        result.smartleadDisabled += 1;
      } catch (error) {
        disableErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`disable #${campaign.id}: ${message}`);
      }
    }

    if (verifyDue && !dryRun) {
      this.state?.setLastAutopauseVerifyAt(new Date().toISOString());
    }
    if (forceAll && !dryRun && disableErrors === 0) {
      this.state?.setAutopauseForceAllAt(new Date().toISOString());
    }
  }
}
