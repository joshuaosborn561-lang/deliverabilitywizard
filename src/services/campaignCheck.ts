import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { campaignIdOf, normalizeTestList } from "../clients/smartdelivery.js";
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
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { desiredMailboxSignature } from "../lib/mailboxSignature.js";
import {
  hasLivingUnwarmedCopyCanary,
  livingKnownGoodEmails,
} from "../lib/canaryCoverage.js";
import {
  foreignCampaignIds,
  ownerClientId,
  type MembershipRow,
} from "../lib/oneClient.js";
import { testedCampaignCoverage } from "../lib/placementCoverage.js";
import { isPocClient } from "../lib/pocClient.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import {
  appendSignatureTag,
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
import { isTerminalCampaignStatus } from "./campaignBounceAutostop.js";
import {
  readMessagePerDay,
  readMinTimeGapMins,
} from "../lib/mailboxSendSettings.js";
import {
  daysSince,
  isPrewarmedGeneric,
  warmupClockStartedAt,
} from "./warmupGate.js";
import { isExcluded } from "./campaignTopUp.js";
import { fetchInventory, type InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 80;

/**
 * A campaign stuck on a blocking first-check finding (bad copy needing a
 * human) is re-inspected hourly, not every 15 minutes. Pre-#109 production
 * had ~10 forever-blocked campaigns re-reading their sequences on every
 * health pass — pure rate-limit burn with an unchanged answer.
 */
const FIRST_CHECK_RETRY_MS = process.env.NODE_TEST_CONTEXT ? 0 : 55 * 60 * 1000;

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

  async run(
    opts: { mode?: CampaignCheckMode; inventory?: InventorySnapshot } = {},
  ): Promise<CampaignCheckResult> {
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

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));
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
    let listedTests: SpamTestSummary[] = [];
    let knownGoodEmails = new Set<string>();
    let listedTestsFailed = false;
    try {
      listedTests = normalizeTestList(await this.smartDelivery.listTests({}));
      const enriched = await this.smartDelivery.enrichCampaignIds(listedTests);
      tested = testedCampaignCoverage(
        enriched,
        this.state.get().testedCampaigns,
      );
      listedTests = enriched;
      knownGoodEmails = livingKnownGoodEmails(
        listedTests,
        this.state.listPodControls(),
      );
    } catch (error) {
      listedTestsFailed = true;
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

    // D85 — zero connected canary mailboxes is ONE fleet-level fact, not a
    // per-campaign finding on every ACTIVE campaign. 48x "canary_inactive"
    // told nobody anything 1x did not, and drowned the findings that have
    // per-campaign fixes. The per-campaign canary checks resume untouched
    // the moment the fleet has a connected mailbox.
    const fleetDown = connectedCanaries === 0;
    if (fleetDown) {
      if (!this.state.getCanaryFleetDown()) {
        this.state.setCanaryFleetDown({
          since: new Date().toISOString(),
          fleetSize: fleetEmails.length,
        });
      }
      console.warn(
        `[campaign-check] canary fleet DOWN — ${fleetEmails.length} known email(s), 0 connected. Placement measurement is blind until the fleet is connected or bought.`,
      );
    } else if (this.state.getCanaryFleetDown()) {
      this.state.clearCanaryFleetDown();
      console.log(
        `[campaign-check] canary fleet back — ${connectedCanaries} connected`,
      );
    }

    const now = new Date().toISOString();
    const sigFixed: Array<{ name: string; brand: string }> = [];
    for (const campaign of campaigns as SmartleadCampaign[]) {
      result.examined += 1;
      const name = String(campaign.name ?? campaign.id);

      // COMPLETED / STOPPED campaigns never send again. Keeping their stale
      // findings alive polluted the scoreboard (2025 campaigns "missing
      // %signature%") and burned hourly inspections on dead ids.
      if (isTerminalCampaignStatus(campaign.status)) {
        if (this.state.getCampaignCheck(campaign.id)) {
          this.state.removeCampaignCheck(campaign.id);
        }
        continue;
      }

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
      // D98 — leftover writable holes close on the next health pass.
      // Do not wait 55 minutes, and do not skip a campaign that already
      // first-passed while the scoreboard still shows the hole. A
      // SmartDelivery list failure must not wipe coverage findings we
      // cannot verify — inspect leftover signatures only in that case.
      const openSigFinding = (record.findings ?? []).some((finding) =>
        finding.startsWith("missing_signature_tag"),
      );
      const openCoverageFinding = (record.findings ?? []).some(
        (finding) =>
          finding.startsWith("no_placement_test") ||
          finding.startsWith("missing_canary") ||
          finding.startsWith("inbox_missing_known_good"),
      );
      const recentlyChecked =
        !openSigFinding &&
        Boolean(
          record.firstCheckAt &&
            Date.now() - Date.parse(record.firstCheckAt) < FIRST_CHECK_RETRY_MS,
        );
      const runFirst =
        needsFirst &&
        (mode === "first" || mode === "all" || mode === "hourly") &&
        (!recentlyChecked || mode !== "first");
      const healthLeftover =
        mode === "first" &&
        (openSigFinding || (openCoverageFinding && !listedTestsFailed));
      const hourlySweep =
        (mode === "hourly" || mode === "all") &&
        Boolean(record.firstPassedAt) &&
        !listedTestsFailed;
      const hourlyLeftoverSig =
        (mode === "hourly" || mode === "all") && openSigFinding;
      const runHourly = healthLeftover || hourlySweep || hourlyLeftoverSig;
      if (!runFirst && !runHourly) continue;

      const kind: "first" | "hourly" = runFirst ? "first" : "hourly";
      let findings = await this.inspect({
        campaign,
        campaigns: campaignById,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        clients,
        brandByClientId,
        allBrands,
        tested,
        listedTests,
        knownGoodEmails,
        clientInboxCounts,
        connectedCanaries,
        fleetSize: fleetEmails.length,
        fleetDown,
        listedTestsFailed,
        depth: kind,
      });
      const clientId =
        typeof campaign.client_id === "number" ? campaign.client_id : null;
      const matched = matchClientForCampaign(name, clients);
      const brand =
        (clientId != null ? brandByClientId.get(clientId) : undefined) ??
        (matched
          ? brandFromClientDisplayName(clientDisplayName(matched))
          : "");
      const sigApplied = await this.autoApplySignature({
        campaignId: campaign.id,
        name,
        brand,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        findings,
      });
      if (sigApplied) {
        findings = findings.filter(
          (finding) => finding.kind !== "missing_signature_tag",
        );
        // D95 — tell Josh the first time we write a campaign. A leftover
        // backfill already notified does not ping again every pass.
        if (!record.sigAutoWrittenAt) {
          sigFixed.push({ name, brand: sigApplied.brand });
        }
      }
      const passed = firstCheckPassed(findings);
      const next: CampaignCheckRecord = {
        ...record,
        name,
        lastKind: kind,
        findings: findings.map(formatFinding),
        sigAutoWrittenAt: sigApplied ? now : record.sigAutoWrittenAt,
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

    if (sigFixed.length && this.slack) {
      const brands = [...new Set(sigFixed.map((row) => row.brand).filter(Boolean))];
      await this.slack.notifyActionResult(
        [
          `I added the signature on ${sigFixed.length} campaign${sigFixed.length === 1 ? "" : "s"}. It sends as the mailbox's first and last name plus the client name${brands.length ? ` (${brands.join(", ")})` : ""}:`,
          ...sigFixed.map((row) => `• ${row.name}`),
        ].join("\n"),
      );
    } else if (sigFixed.length) {
      console.log(
        `[campaign-check] signatures written=${sigFixed.length} (no Slack client)`,
      );
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

  /**
   * D92 — missing signature is written, not asked. Appends `%signature%`
   * (mailbox expands it to First Last / client brand) and sets the
   * mailbox signature to that two-line pair. Slack once per campaign
   * the first time we write it (D95) — a leftover backfill does not
   * re-ping every health / hourly pass.
   */
  private async autoApplySignature(input: {
    campaignId: number;
    name: string;
    brand: string;
    accounts: SmartleadAccountWithCampaigns[];
    findings: CampaignFinding[];
  }): Promise<{ brand: string } | null> {
    if (!input.findings.some((finding) => finding.kind === "missing_signature_tag")) {
      return null;
    }
    if (this.config.dryRun) {
      console.log(
        `[campaign-check] dry-run signature #${input.campaignId} ${input.name}`,
      );
      return { brand: input.brand };
    }
    try {
      const sequences = await this.smartlead.getCampaignSequences(input.campaignId);
      const { sequences: next, changed } = appendSignatureTag(sequences ?? []);
      if (changed.length) {
        await this.smartlead.updateCampaignSequences(input.campaignId, next);
        await sleep(WRITE_GAP_MS);
      }
      for (const account of input.accounts) {
        if (!campaignIdsOf(account).includes(input.campaignId)) continue;
        const desired = desiredMailboxSignature({
          fromName: account.from_name,
          signature: account.signature,
          clientBrand: input.brand,
        });
        if (!desired || (account.signature ?? "") === desired) continue;
        if (typeof account.id !== "number") continue;
        await this.smartlead.updateEmailAccount(account.id, { signature: desired });
        await sleep(WRITE_GAP_MS);
      }
      console.log(
        `[campaign-check] signature written #${input.campaignId} ${input.name} brand=${input.brand || "unknown"}`,
      );
      return { brand: input.brand };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[campaign-check] signature write failed #${input.campaignId}: ${message}`,
      );
      return null;
    }
  }

  private async inspect(input: {
    campaign: SmartleadCampaign;
    campaigns: Map<number, SmartleadCampaign>;
    accounts: SmartleadAccountWithCampaigns[];
    clients: SmartleadClientRecord[];
    brandByClientId: Map<number, string>;
    allBrands: string[];
    tested: Set<string>;
    listedTests: SpamTestSummary[];
    knownGoodEmails: Set<string>;
    clientInboxCounts: Map<string, number>;
    connectedCanaries: number;
    fleetSize: number;
    fleetDown: boolean;
    listedTestsFailed: boolean;
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
      if (
        !this.state.isCopyCanary(email) &&
        !isPrewarmedGeneric(account, email, this.config, this.state)
      ) {
        const started = warmupClockStartedAt(account, email, this.state);
        const days = started != null ? daysSince(started) : null;
        if (days == null || days < this.config.campaignMinWarmupDays) {
          findings.push({
            kind: "under_warmed",
            detail: `${email} has ${days == null ? "no" : `${days.toFixed(1)}d`} warmup (owes ${this.config.campaignMinWarmupDays})`,
          });
        }
      }
      const gap = readMinTimeGapMins(account);
      if (Number.isFinite(gap) && gap !== this.config.mailboxMinTimeGapMins) {
        findings.push({
          kind: "mailbox_gap",
          detail: `${email} gap ${gap}m (want ${this.config.mailboxMinTimeGapMins})`,
        });
      }
      const volume = readMessagePerDay(account);
      if (Number.isFinite(volume) && volume !== this.config.messagePerDay) {
        findings.push({
          kind: "mailbox_volume",
          detail: `${email} ${volume}/day (want ${this.config.messagePerDay})`,
        });
      }
    }

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
        if (input.depth === "first" && expected) {
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
      if (
        input.depth === "hourly" &&
        !input.listedTestsFailed &&
        !input.tested.has(String(campaign.id))
      ) {
        findings.push({
          kind: "no_placement_test",
          detail: "no recurring SmartDelivery test for serving inboxes",
        });
      }
      if (!input.listedTestsFailed) {
        const living = input.listedTests.find(
          (test) => Number(campaignIdOf(test)) === campaign.id,
        );
        const inbox = Number(living?.inbox_count ?? 0);
        const tab = Number(living?.tab_count ?? 0);
        const spam = Number(living?.spam_count ?? 0);
        const total = inbox + tab + spam;
        if (living && total > 0) {
          const rate = (inbox / total) * 100;
          if (rate < this.config.launchInboxThreshold) {
            findings.push({
              kind: "below_launch_bar",
              detail: `${rate.toFixed(0)}% inbox (bar ${this.config.launchInboxThreshold}%; promo counts as a miss)`,
            });
          }
        }
      }

      if (input.depth === "hourly" && !input.listedTestsFailed) {
        const missingKnownGood = serving.filter(
          (email) => !input.knownGoodEmails.has(email),
        );
        if (missingKnownGood.length) {
          findings.push({
            kind: "inbox_missing_known_good",
            detail: `${missingKnownGood.length} serving inbox(es) not on a known-good copy canary: ${missingKnownGood.slice(0, 3).join(", ")}`,
          });
        }
      }

      // D85 — with zero connected canary mailboxes, every campaign fails
      // these for the same fleet-level reason. That fact lives once on the
      // scoreboard (canaryFleetDown), not 48 times here.
      const storedCanaryId = this.state.getCopyCanaryTestId(campaign.id);
      if (
        !input.fleetDown &&
        !input.listedTestsFailed &&
        !hasLivingUnwarmedCopyCanary(
          campaign.id,
          input.listedTests,
          storedCanaryId,
        )
      ) {
        findings.push({
          kind: "missing_canary",
          detail:
            "campaign copy is not on the unwarmed senders canary (Canary copy test)",
        });
      }
      // canary_inactive stays a valid kind for stored records, but the live
      // condition (zero connected fleet mailboxes) IS the fleet-down fact —
      // it is reported once above, never per campaign.
    }

    return findings;
  }
}
