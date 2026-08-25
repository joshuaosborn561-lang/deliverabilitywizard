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
import {
  desiredBounceAutopausePercent,
  readBounceAutopausePercent,
} from "../lib/bounceAutopause.js";
import { matchClientForCampaign } from "../lib/campaignClient.js";
import {
  firstCheckPassed,
  formatFinding,
  isFirstCheckBlocking,
  type CampaignCheckRecord,
  type CampaignFinding,
} from "../lib/campaignCheck.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { allowsGenericStaff } from "../lib/clientStaffFloor.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { sleep } from "../lib/http.js";
import {
  foreignCampaignIds,
  ownerClientId,
  type MembershipRow,
} from "../lib/oneClient.js";
import { testedCampaignCoverage } from "../lib/placementCoverage.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import {
  clientBrandList,
  findForeignBrand,
  missingSignatureTag,
  sequenceCopyHay,
  signatureHay,
} from "../lib/signatureQa.js";
import { isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isExcluded } from "./campaignTopUp.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 80;

export type CampaignCheckMode = "first" | "hourly" | "all";

export interface CampaignCheckResult {
  mode: CampaignCheckMode;
  dryRun: boolean;
  examined: number;
  firstSeen: number;
  firstChecked: number;
  firstPassed: number;
  swept: number;
  blocked: string[];
  findings: Array<{
    campaignId: number;
    name: string;
    kind: "first" | "hourly";
    passed: boolean;
    findings: CampaignFinding[];
  }>;
}

/**
 * D80 — when a campaign id is new, run the first-check. After it passes,
 * hourly sweeps watch pod/shell, signatures, client tag, and staffing.
 */
export class CampaignCheckService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { mode?: CampaignCheckMode } = {}): Promise<CampaignCheckResult> {
    const mode = opts.mode ?? "all";
    const result: CampaignCheckResult = {
      mode,
      dryRun: this.config.dryRun,
      examined: 0,
      firstSeen: 0,
      firstChecked: 0,
      firstPassed: 0,
      swept: 0,
      blocked: [],
      findings: [],
    };

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
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [campaign.id, campaign]),
    );

    let tested = new Set<string>();
    if (mode === "hourly" || mode === "all") {
      try {
        const listed = normalizeTestList(await this.smartDelivery.listTests({}));
        const enriched = await this.smartDelivery.enrichCampaignIds(listed);
        tested = testedCampaignCoverage(
          enriched,
          this.state.get().testedCampaigns,
        );
      } catch (error) {
        console.warn("[campaign-check] could not list tests", error);
      }
    }

    const now = new Date().toISOString();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      result.examined += 1;
      const name = String(campaign.name ?? campaign.id);
      const existing = this.state.getCampaignCheck(campaign.id);
      if (!existing) {
        result.firstSeen += 1;
        this.state.upsertCampaignCheck({
          campaignId: campaign.id,
          name,
          firstSeenAt: now,
          firstCheckAt: null,
          firstPassedAt: null,
          lastSweepAt: null,
          lastKind: "first",
          findings: [],
        });
      }
      const record = this.state.getCampaignCheck(campaign.id)!;
      const needsFirst = !record.firstPassedAt;
      const runFirst = needsFirst && (mode === "first" || mode === "all" || mode === "hourly");
      const runHourly = Boolean(record.firstPassedAt) && (mode === "hourly" || mode === "all");
      if (!runFirst && !runHourly) continue;

      const kind: "first" | "hourly" = runFirst ? "first" : "hourly";
      const findings = await this.inspect({
        campaign,
        campaigns: campaignById,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        clients,
        brandByClientId,
        allBrands,
        tested,
        depth: kind,
      });
      const passed = firstCheckPassed(findings);
      const next: CampaignCheckRecord = {
        ...record,
        name,
        lastKind: kind,
        findings: findings.map(formatFinding),
      };
      if (kind === "first") {
        next.firstCheckAt = now;
        next.firstPassedAt = passed ? now : null;
        result.firstChecked += 1;
        if (passed) result.firstPassed += 1;
      } else {
        next.lastSweepAt = now;
        if (!passed) next.firstPassedAt = null;
        result.swept += 1;
      }
      this.state.upsertCampaignCheck(next);
      result.findings.push({
        campaignId: campaign.id,
        name,
        kind,
        passed,
        findings,
      });
      for (const finding of findings) {
        console.log(
          `[campaign-check] ${kind} #${campaign.id} ${name} — ${formatFinding(finding)}`,
        );
        if (isFirstCheckBlocking(finding.kind)) {
          result.blocked.push(`#${campaign.id} ${name}: ${formatFinding(finding)}`);
        }
      }
      if (!findings.length) {
        console.log(`[campaign-check] ${kind} #${campaign.id} ${name} — clean`);
      }
    }

    await this.state.save();
    console.log(
      `[campaign-check] mode=${mode} examined=${result.examined} firstSeen=${result.firstSeen} firstChecked=${result.firstChecked} firstPassed=${result.firstPassed} swept=${result.swept} blocked=${result.blocked.length}`,
    );
    return result;
  }

  private async inspect(input: {
    campaign: SmartleadCampaign;
    campaigns: Map<number, SmartleadCampaign>;
    accounts: SmartleadAccountWithCampaigns[];
    clients: SmartleadClientRecord[];
    brandByClientId: Map<number, string>;
    allBrands: string[];
    tested: Set<string>;
    depth: "first" | "hourly";
  }): Promise<CampaignFinding[]> {
    const findings: CampaignFinding[] = [];
    const { campaign } = input;
    const name = String(campaign.name ?? campaign.id);
    const status = String(campaign.status ?? "").toUpperCase();
    const shell = isPodControlShellCampaign(campaign);
    const excluded = isExcluded(campaign, this.config.topUpExcludeCampaigns);

    if (shell) {
      if (status !== "PAUSED") {
        findings.push({
          kind: "shell_not_paused",
          detail: `pod control shell is ${status || "unknown"} — must stay PAUSED`,
        });
      }
      return findings;
    }

    if (typeof campaign.client_id !== "number") {
      findings.push({
        kind: "missing_client_tag",
        detail: "no Smartlead client_id",
      });
    } else {
      const matched = matchClientForCampaign(name, input.clients);
      if (matched && matched.id !== campaign.client_id) {
        findings.push({
          kind: "client_mismatch",
          detail: `name matches ${clientDisplayName(matched)} (${matched.id}) but tagged ${campaign.client_id}`,
        });
      }
    }

    const clientName = clientDisplayName(
      input.clients.find((client) => client.id === campaign.client_id),
    );
    const expected =
      typeof campaign.client_id === "number"
        ? input.brandByClientId.get(campaign.client_id) ?? ""
        : "";
    const allowsGenerics = allowsGenericStaff(
      campaign,
      clientName,
      this.config.genericStaffNamePatterns,
    );

    if (input.depth === "first") {
      try {
        const settings = await this.smartlead.getCampaignSettings(campaign.id);
        await sleep(WRITE_GAP_MS);
        const actual = readBounceAutopausePercent(settings);
        const desired = desiredBounceAutopausePercent(name);
        if (actual !== desired) {
          findings.push({
            kind: "bounce_autopause",
            detail: `bounce auto-pause is ${actual ?? "unset"}, want ${desired}%`,
          });
        }
      } catch (error) {
        console.warn(
          `[campaign-check] could not read settings for #${campaign.id}`,
          error,
        );
      }
    }

    const attached = input.accounts.filter((account) =>
      campaignIdsOf(account).includes(campaign.id),
    );
    for (const account of attached) {
      const email = accountEmail(account);
      if (!email) continue;
      if (expected) {
        const hay = signatureHay({
          fromName: account.from_name,
          signature: account.signature,
        });
        const foreign = findForeignBrand(hay, expected, input.allBrands);
        if (foreign) {
          findings.push({
            kind: "mailbox_sig",
            detail: `${email} carries ${foreign} (expected ${expected})`,
          });
        }
      }
      const generic = isGenericMailbox(
        account,
        email,
        this.config,
        this.state,
      );
      if (generic && !allowsGenerics) {
        findings.push({
          kind: "generic_on_non_goliath",
          detail: `${email} is a generic on a campaign that may not take generics`,
        });
      }
      const memberships: MembershipRow[] = campaignIdsOf(account).map((id) => {
        const other = input.campaigns.get(id);
        return {
          campaignId: id,
          clientId: typeof other?.client_id === "number" ? other.client_id : null,
          shell: other ? isPodControlShellCampaign(other) : false,
        };
      });
      const goliath = input.clients.find((client) =>
        /goliath/i.test(clientDisplayName(client)),
      );
      const owner = ownerClientId(account.client_id, memberships, {
        generic,
        genericOwnerId: generic ? (goliath?.id ?? null) : null,
      });
      const foreign = foreignCampaignIds(owner, memberships);
      if (foreign.length) {
        findings.push({
          kind: "cross_client_membership",
          detail: `${email} also sits on ${foreign.map((id) => `#${id}`).join(", ")}`,
        });
      }
    }

    if (input.depth === "first") {
      try {
        const sequences = await this.smartlead.getCampaignSequences(campaign.id);
        await sleep(WRITE_GAP_MS);
        for (const row of sequenceCopyHay(sequences ?? [])) {
          if (missingSignatureTag(row.text)) {
            findings.push({
              kind: "missing_signature_tag",
              detail: `${row.label} is missing %signature%`,
            });
          }
          if (expected) {
            const foreign = findForeignBrand(row.text, expected, input.allBrands);
            if (foreign) {
              findings.push({
                kind: "foreign_brand_in_copy",
                detail: `${row.label} has ${foreign} in the copy`,
              });
            }
          }
        }
      } catch (error) {
        console.warn(
          `[campaign-check] could not read sequences for #${campaign.id}`,
          error,
        );
      }
    }

    if (input.depth === "hourly" && status === "ACTIVE" && !excluded) {
      const staffable = attached.filter((account) => {
        const email = accountEmail(account)?.toLowerCase();
        if (!email) return false;
        return isStaffableSender(account, {
          held: Boolean(this.state.getHeldInbox(email)),
          resting: Boolean(this.state.getRestingInbox(email)),
          inboxThreshold: this.config.remediationInboxThreshold,
        });
      }).length;
      const shortBy = Math.max(0, this.config.minCampaignSenders - staffable);
      if (shortBy > 0) {
        findings.push({
          kind: "understaffed",
          detail: `staffable ${staffable}/${this.config.minCampaignSenders} (short ${shortBy})`,
        });
      }
      if (!input.tested.has(String(campaign.id))) {
        findings.push({
          kind: "no_placement_test",
          detail: "no recurring SmartDelivery test",
        });
      }
    }

    return findings;
  }
}
