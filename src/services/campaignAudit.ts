import type { AppConfig } from "../config.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { normalizeTestList } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import { testedCampaignCoverage } from "../lib/placementCoverage.js";
import {
  clientBrandList,
  findForeignBrand,
  missingSignatureTag,
  sequenceCopyHay,
  signatureHay,
} from "../lib/signatureQa.js";
import {
  countClientInboxesByKey,
  staffFloorForCampaign,
} from "../lib/clientStaffFloor.js";
import { isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

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
  /** All campaign memberships (includes disconnected / held). */
  senders: number;
  /** Connected + inboxing senders that count toward the D25 floor. */
  staffable: number;
  /** Half this client's inboxes (D58 / D82). */
  floor: number;
  /** Staffable senders still needed to reach that floor. */
  shortBy: number;
  hasTest: boolean;
  /** Sending domains in use, commonest first — a campaign's brand identity. */
  domains: Array<{ domain: string; count: number }>;
}

export interface SupplyForecast {
  /** Pool mailboxes usable right now. */
  availableNow: number;
  /** Pool mailboxes still serving warmup, with the date each frees up. */
  warmingUntil: Array<{ date: string; count: number }>;
  /** Held senders and the date their hold expires. */
  heldUntil: Array<{ date: string; count: number }>;
}

export interface SignatureQaIssue {
  campaignId: number;
  campaignName: string;
  kind: "mailbox_sig" | "missing_signature_tag" | "foreign_brand_in_copy";
  detail: string;
}

export interface CampaignAuditResult {
  campaigns: CampaignAuditRow[];
  untested: CampaignAuditRow[];
  understaffed: CampaignAuditRow[];
  signatureIssues: SignatureQaIssue[];
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

  async run(_legacyMinSenders?: number): Promise<CampaignAuditResult> {
    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);

    const senderCounts = new Map<number, number>();
    const staffableCounts = new Map<number, number>();
    const domainsByCampaign = new Map<number, Map<string, number>>();
    // Mailboxes carrying no campaign at all are idle capacity we can place
    // without taking a sender off another campaign.
    const idleByDomain = new Map<string, number>();
    const inboxThreshold = this.config.remediationInboxThreshold;

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email) continue;
      const domain = email.split("@")[1] ?? "";
      const ids = campaignIdsOf(account);
      if (!ids.length) {
        if (domain) idleByDomain.set(domain, (idleByDomain.get(domain) ?? 0) + 1);
        continue;
      }
      const held = this.state.getHeldInbox(email);
      const resting = Boolean(this.state.getRestingInbox(email));
      const staffable = isStaffableSender(account, {
        held: Boolean(held),
        resting,
        inboxRate: held?.inboxRate,
        inboxThreshold,
      });
      for (const id of ids) {
        senderCounts.set(id, (senderCounts.get(id) ?? 0) + 1);
        if (staffable) {
          staffableCounts.set(id, (staffableCounts.get(id) ?? 0) + 1);
        }
        if (!domain) continue;
        const byDomain = domainsByCampaign.get(id) ?? new Map<string, number>();
        byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
        domainsByCampaign.set(id, byDomain);
      }
    }

    let tested = new Set<string>();
    try {
      const listed = normalizeTestList(await this.smartDelivery.listTests({}));
      const enriched = await this.smartDelivery.enrichCampaignIds(listed);
      tested = testedCampaignCoverage(
        enriched,
        this.state.get().testedCampaigns,
      );
    } catch (error) {
      console.warn("[campaign-audit] could not list tests", error);
    }

    const clientInboxCounts = countClientInboxesByKey(
      accounts as SmartleadAccountWithCampaigns[],
      campaigns as SmartleadCampaign[],
      clients,
      this.config,
      this.state,
    );

    const rows: CampaignAuditRow[] = campaigns
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .filter((c) => !isAnyShellCampaign(c))
      .map((c) => {
        const senders = senderCounts.get(c.id) ?? 0;
        const staffable = staffableCounts.get(c.id) ?? 0;
        const clientName =
          typeof c.client_id === "number"
            ? clientDisplayName(clients.find((row) => row.id === c.client_id))
            : "";
        const floor = staffFloorForCampaign(c, clientInboxCounts, clientName);
        return {
          id: c.id,
          name: String(c.name ?? `campaign ${c.id}`),
          status: String(c.status ?? ""),
          senders,
          staffable,
          floor,
          shortBy: Math.max(0, floor - staffable),
          hasTest: tested.has(String(c.id)),
          domains: [...(domainsByCampaign.get(c.id) ?? new Map())]
            .map(([domain, count]) => ({ domain, count }))
            .sort((a, b) => b.count - a.count),
        };
      })
      .sort((a, b) => a.staffable - b.staffable);

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
    const signatureIssues = await this.auditSignatures({
      campaigns: campaigns as SmartleadCampaign[],
      accounts: accounts as SmartleadAccountWithCampaigns[],
      brandByClientId,
      allBrands,
    });
    const result: CampaignAuditResult = {
      campaigns: rows,
      untested,
      understaffed,
      signatureIssues,
      totalShortfall: understaffed.reduce((sum, r) => sum + r.shortBy, 0),
      supply,
    };

    console.log(
      `[campaign-audit] ${rows.length} active campaign(s); ${untested.length} without a placement test; ${understaffed.length} under their half-client floor (short ${result.totalShortfall} total); ${signatureIssues.length} signature QA miss(es)`,
    );
    for (const r of rows) {
      const brands = r.domains
        .slice(0, 4)
        .map((d) => `${d.domain}:${d.count}`)
        .join(" ");
      console.log(
        `[campaign-audit]   #${r.id} ${r.name} — staffable ${r.staffable}/${r.floor} (membership ${r.senders})${r.shortBy ? ` short ${r.shortBy}` : ""}${r.hasTest ? "" : " NO-TEST"} [${brands}]`,
      );
    }
    const idle = [...idleByDomain.entries()].sort((a, b) => b[1] - a[1]);
    console.log(
      `[campaign-audit] idle mailboxes (no campaign): ${idle.reduce((n, [, c]) => n + c, 0)} across ${idle.length} domain(s)`,
    );
    for (const [domain, count] of idle.slice(0, 40)) {
      console.log(`[campaign-audit]   idle ${domain} ${count}`);
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

    const activeIds = new Set(rows.map((row) => row.id));
    this.state.setFleetSummary({
      generatedAt: new Date().toISOString(),
      totalMailboxes: accounts.filter((account) =>
        Boolean(accountEmail(account)),
      ).length,
      sendingMailboxes: new Set(
        accounts
          .filter(
            (account) =>
              Boolean(accountEmail(account)) &&
              campaignIdsOf(account).some((id) => activeIds.has(id)),
          )
          .map((account) => account.id),
      ).size,
      activeCampaigns: rows.length,
      disconnectedMailboxes: accounts.filter(
        (account) =>
          account.is_smtp_success === false ||
          account.is_imap_success === false,
      ).length,
    });
    await this.state.save();

    return result;
  }

  private async auditSignatures(input: {
    campaigns: SmartleadCampaign[];
    accounts: SmartleadAccountWithCampaigns[];
    brandByClientId: Map<number, string>;
    allBrands: string[];
  }): Promise<SignatureQaIssue[]> {
    const issues: SignatureQaIssue[] = [];
    const live = input.campaigns.filter((campaign) => {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") return false;
      return !isAnyShellCampaign(campaign);
    });

    for (const campaign of live) {
      const expected =
        typeof campaign.client_id === "number"
          ? input.brandByClientId.get(campaign.client_id) ?? ""
          : "";
      if (!expected) continue;

      for (const account of input.accounts) {
        if (!campaignIdsOf(account).includes(campaign.id)) continue;
        const email = accountEmail(account);
        if (!email) continue;
        const hay = signatureHay({
          fromName: account.from_name,
          signature: account.signature,
        });
        const foreign = findForeignBrand(hay, expected, input.allBrands);
        if (!foreign) continue;
        const detail = `${email} carries ${foreign} (expected ${expected})`;
        issues.push({
          campaignId: campaign.id,
          campaignName: String(campaign.name ?? campaign.id),
          kind: "mailbox_sig",
          detail,
        });
        console.log(
          `[campaign-audit] SIG-MISMATCH #${campaign.id} ${campaign.name} — ${detail}`,
        );
      }

      try {
        const sequences = await this.smartlead.getCampaignSequences(campaign.id);
        await sleep(80);
        for (const row of sequenceCopyHay(sequences ?? [])) {
          if (missingSignatureTag(row.text)) {
            const detail = `${row.label} is missing %signature%`;
            issues.push({
              campaignId: campaign.id,
              campaignName: String(campaign.name ?? campaign.id),
              kind: "missing_signature_tag",
              detail,
            });
            console.log(
              `[campaign-audit] SIG-MISSING-TAG #${campaign.id} ${campaign.name} — ${detail}`,
            );
          }
          const foreign = findForeignBrand(row.text, expected, input.allBrands);
          if (foreign) {
            const detail = `${row.label} has ${foreign} in the copy`;
            issues.push({
              campaignId: campaign.id,
              campaignName: String(campaign.name ?? campaign.id),
              kind: "foreign_brand_in_copy",
              detail,
            });
            console.log(
              `[campaign-audit] SIG-FOREIGN-COPY #${campaign.id} ${campaign.name} — ${detail}`,
            );
          }
        }
      } catch (error) {
        console.warn(
          `[campaign-audit] could not read sequences for #${campaign.id}`,
          error,
        );
      }
    }

    return issues;
  }
}
