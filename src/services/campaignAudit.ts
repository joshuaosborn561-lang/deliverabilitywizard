import type { AppConfig } from "../config.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  normalizeTestList,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";

/**
 * Standing audit of live campaigns: sender headcount and placement-test cover.
 *
 * Two things can silently degrade a campaign — it loses senders to recovery
 * holds until it is barely sending, or it never picked up a placement test
 * and nothing is watching its inbox rate. Neither shows up in the remediation
 * summary, which reports on mailboxes rather than campaigns.
 */

export interface CampaignAuditRow {
  id: number;
  name: string;
  status: string;
  senders: number;
  /** Senders still needed to reach the configured floor. */
  shortBy: number;
  hasTest: boolean;
}

export interface SupplyForecast {
  /** Pool mailboxes usable right now. */
  availableNow: number;
  /** Pool mailboxes still serving warmup, with the date each frees up. */
  warmingUntil: Array<{ date: string; count: number }>;
  /** Held senders and the date their hold expires. */
  heldUntil: Array<{ date: string; count: number }>;
}

export interface CampaignAuditResult {
  campaigns: CampaignAuditRow[];
  untested: CampaignAuditRow[];
  understaffed: CampaignAuditRow[];
  totalShortfall: number;
  supply: SupplyForecast;
}

function groupByDate(dates: string[]): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const day = d.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class CampaignAuditService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly state: StateStore,
  ) {}

  async run(minSenders: number): Promise<CampaignAuditResult> {
    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);

    const senderCounts = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      if (!accountEmail(account)) continue;
      for (const id of campaignIdsOf(account)) {
        senderCounts.set(id, (senderCounts.get(id) ?? 0) + 1);
      }
    }

    const tested = new Set<string>();
    try {
      for (const test of normalizeTestList(
        await this.smartDelivery.listTests({}),
      )) {
        const cid = campaignIdOf(test);
        if (cid) tested.add(String(cid));
      }
    } catch (error) {
      console.warn("[campaign-audit] could not list tests", error);
    }
    for (const id of Object.keys(this.state.get().testedCampaigns)) {
      tested.add(id);
    }

    const rows: CampaignAuditRow[] = campaigns
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .map((c) => {
        const senders = senderCounts.get(c.id) ?? 0;
        return {
          id: c.id,
          name: String(c.name ?? `campaign ${c.id}`),
          status: String(c.status ?? ""),
          senders,
          shortBy: Math.max(0, minSenders - senders),
          hasTest: tested.has(String(c.id)),
        };
      })
      .sort((a, b) => a.senders - b.senders);

    const pool = this.state.listPoolMailboxes();
    const warmupMs = this.config.poolWarmupDays * 86_400_000;
    const supply: SupplyForecast = {
      availableNow: pool.filter((m) => m.status === "available").length,
      warmingUntil: groupByDate(
        pool
          .filter((m) => m.status === "warming" && m.warmedAt)
          .map((m) =>
            new Date(Date.parse(m.warmedAt!) + warmupMs).toISOString(),
          ),
      ),
      heldUntil: groupByDate(
        this.state
          .listHeldInboxes()
          .map((h) => h.holdUntil)
          .filter((d): d is string => !!d),
      ),
    };

    const untested = rows.filter((r) => !r.hasTest);
    const understaffed = rows.filter((r) => r.shortBy > 0);
    const result: CampaignAuditResult = {
      campaigns: rows,
      untested,
      understaffed,
      totalShortfall: understaffed.reduce((sum, r) => sum + r.shortBy, 0),
      supply,
    };

    console.log(
      `[campaign-audit] ${rows.length} active campaign(s); ${untested.length} without a placement test; ${understaffed.length} under ${minSenders} senders (short ${result.totalShortfall} total)`,
    );
    for (const r of rows) {
      console.log(
        `[campaign-audit]   #${r.id} ${r.name} — ${r.senders} sender(s)${r.shortBy ? ` (short ${r.shortBy})` : ""}${r.hasTest ? "" : " NO-TEST"}`,
      );
    }
    console.log(
      `[campaign-audit] supply: ${supply.availableNow} available now`,
    );
    for (const w of supply.warmingUntil) {
      console.log(`[campaign-audit]   ${w.count} pool mailbox(es) warm on ${w.date}`);
    }
    for (const h of supply.heldUntil) {
      console.log(`[campaign-audit]   ${h.count} held sender(s) release on ${h.date}`);
    }

    return result;
  }
}
