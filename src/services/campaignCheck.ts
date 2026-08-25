import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { matchClientForCampaign } from "../lib/campaignClient.js";
import {
  firstCheckPassed,
  formatFinding,
  isFirstCheckBlocking,
  type CampaignCheckRecord,
  type CampaignFinding,
} from "../lib/campaignCheck.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import {
  countClientInboxesByKey,
  staffFloorForCampaign,
} from "../lib/clientStaffFloor.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { campaignMayTakeGenerics } from "../lib/genericBackfill.js";
import { sleep } from "../lib/http.js";
import { requestIsolationAction, buildIsolationAction } from "../lib/isolationActions.js";
import {
  campaignIdFromCanaryTestName,
  isCanaryCopyTestName,
} from "../lib/isolationNames.js";
import {
  foreignCampaignIds,
  ownerClientId,
  type MembershipRow,
} from "../lib/oneClient.js";
import { testedCampaignCoverage } from "../lib/placementCoverage.js";
import { isPocClient } from "../lib/pocClient.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import {
  clientBrandList,
  findForeignBrand,
  missingSignatureTag,
  sequenceCopyHay,
  signatureHay,
} from "../lib/signatureQa.js";
import { isConnectedAccount, isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import type { SpamTestSummary } from "../types/index.js";
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

function livingCanaryCampaignIds(tests: SpamTestSummary[]): Set<number> {
  const out = new Set<number>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const named = campaignIdFromCanaryTestName(test.test_name);
    if (named) {
      out.add(named);
      continue;
    }
    if (!isCanaryCopyTestName(test.test_name)) continue;
    const cid = Number(campaignIdOf(test));
    if (Number.isFinite(cid) && cid > 0) out.add(cid);
  }
  return out;
}

/**
 * D81 — when a campaign id is new, run the first-check. After it passes,
 * hourly sweeps watch pod/shell, signatures, canaries, and the half-client
 * floor. Bounce auto-pause is not this checker.
 */
export class CampaignCheckService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly state: StateStore,
    private readonly slack?: SlackClient,
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
    const clientInboxCounts = countClientInboxesByKey(
      accounts as SmartleadAccountWithCampaigns[],
      campaigns as SmartleadCampaign[],
      clients,
      this.config,
      this.state,
    );

    let tested = new Set<string>();
    let canaryCampaigns = new Set<number>();
    let listedTests: SpamTestSummary[] = [];
    try {
      listedTests = normalizeTestList(await this.smartDelivery.listTests({}));
      const enriched = await this.smartDelivery.enrichCampaignIds(listedTests);
      tested = testedCampaignCoverage(
        enriched,
        this.state.get().testedCampaigns,
      );
      canaryCampaigns = livingCanaryCampaignIds(enriched);
    } catch (error) {
      console.warn("[campaign-check] could not list tests", error);
    }

    const fleetEmails = (this.state.getCopyCanaryFleet()?.emails ?? []).map((email) =>
      email.toLowerCase(),
    );
    const connectedCanaries = (accounts as SmartleadAccountWithCampaigns[]).filter(
      (account) => {
        const email = accountEmail(account)?.toLowerCase();
        return Boolean(email && fleetEmails.includes(email) && isConnectedAccount(account));
      },
    ).length;

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
        canaryCampaigns,
        listedTests,
        clientInboxCounts,
        connectedCanaries,
        fleetSize: fleetEmails.length,
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
      await this.maybeAskGenericBackfill(campaign, name, findings);
    }

    await this.state.save();
    console.log(
      `[campaign-check] mode=${mode} examined=${result.examined} firstSeen=${result.firstSeen} firstChecked=${result.firstChecked} firstPassed=${result.firstPassed} swept=${result.swept} blocked=${result.blocked.length}`,
    );
    return result;
  }

  private async maybeAskGenericBackfill(
    campaign: SmartleadCampaign,
    name: string,
    findings: CampaignFinding[],
  ): Promise<void> {
    if (!this.slack) return;
    if (!findings.some((finding) => finding.kind === "generic_unapproved")) return;
    await requestIsolationAction({
      store: this.state,
      slack: this.slack,
      action: buildIsolationAction({
        kind: "generic_backfill",
        title: `Generics on ${name}`,
        proof: `Pool generics are attached to #${campaign.id} ${name}. Floor stays half this client's inboxes. Tap Allow generics if they should stay.`,
        detail: { campaignId: campaign.id, campaignName: name },
      }),
    });
  }

  private async inspect(input: {
    campaign: SmartleadCampaign;
    campaigns: Map<number, SmartleadCampaign>;
    accounts: SmartleadAccountWithCampaigns[];
    clients: SmartleadClientRecord[];
    brandByClientId: Map<number, string>;
    allBrands: string[];
    tested: Set<string>;
    canaryCampaigns: Set<number>;
    listedTests: SpamTestSummary[];
    clientInboxCounts: Map<string, number>;
    connectedCanaries: number;
    fleetSize: number;
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
    const mayTakeGenerics = campaignMayTakeGenerics(
      campaign,
      clientName,
      this.config.pocClientNamePatterns,
      this.state.listGenericBackfillApprovals(),
    );
    const pocOwner = input.clients.find((client) =>
      isPocClient(clientDisplayName(client), this.config.pocClientNamePatterns),
    );

    const attached = input.accounts.filter((account) =>
      campaignIdsOf(account).includes(campaign.id),
    );
    const serving: string[] = [];
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
      if (generic && !mayTakeGenerics) {
        findings.push({
          kind: "generic_unapproved",
          detail: `${email} is a generic — needs Josh Slack approve (POC clients are pre-allowed)`,
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
      const owner = ownerClientId(account.client_id, memberships, {
        generic,
        genericOwnerId: generic ? (pocOwner?.id ?? null) : null,
      });
      const foreign = foreignCampaignIds(owner, memberships);
      if (foreign.length) {
        findings.push({
          kind: "cross_client_membership",
          detail: `${email} also sits on ${foreign.map((id) => `#${id}`).join(", ")}`,
        });
      }
      if (
        isStaffableSender(account, {
          held: Boolean(this.state.getHeldInbox(email.toLowerCase())),
          resting: Boolean(this.state.getRestingInbox(email.toLowerCase())),
          inboxThreshold: this.config.remediationInboxThreshold,
        })
      ) {
        serving.push(email.toLowerCase());
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

    if (status === "ACTIVE" && !excluded) {
      const floor = staffFloorForCampaign(
        campaign,
        input.clientInboxCounts,
        clientName,
      );
      const shortBy = Math.max(0, floor - serving.length);
      if (input.depth === "hourly" && shortBy > 0) {
        findings.push({
          kind: "understaffed",
          detail: `staffable ${serving.length}/${floor} (half this client's inboxes)`,
        });
      }
      if (input.depth === "hourly" && !input.tested.has(String(campaign.id))) {
        findings.push({
          kind: "no_placement_test",
          detail: "no recurring SmartDelivery test for serving inboxes",
        });
      }

      const storedCanaryId = this.state.getCopyCanaryTestId(campaign.id);
      const storedLiving =
        Boolean(storedCanaryId) &&
        input.listedTests.some(
          (test) =>
            testIdOf(test) === storedCanaryId &&
            isAutomatedTest(test) &&
            isTestStoppable(test),
        );
      if (!input.canaryCampaigns.has(campaign.id) && !storedLiving) {
        findings.push({
          kind: "missing_canary",
          detail: `${serving.length} serving inbox(es) have no active canary-copy test`,
        });
      }
      if (input.fleetSize > 0 && input.connectedCanaries === 0) {
        findings.push({
          kind: "canary_inactive",
          detail: "canary fleet mailboxes are not connected in Smartlead",
        });
      }
    }

    return findings;
  }
}
