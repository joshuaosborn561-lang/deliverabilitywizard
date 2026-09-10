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
import {
  desiredMailboxSignature,
  extractSignatureLines,
  mailboxSignatureMismatch,
} from "../lib/mailboxSignature.js";
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
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  appendSignatureTag,
  bodyHasInsightClose,
  clientBrandList,
  ensureInsightCloseOnSequences,
  findForeignBrand,
  missingSignatureTag,
  sequenceBodiesContainInsight,
  sequenceCopyHay,
  sequencesNeedInsightClose,
  sequencesHaveSignaturePlaceholder,
} from "../lib/signatureQa.js";
import { isConnectedAccount, isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";
import type { SpamTestSummary } from "../types/index.js";
import { isTerminalCampaignStatus } from "./campaignBounceAutostop.js";
import { campaignSettingsWriteBody } from "../lib/bounceAutopause.js";
import {
  readMessagePerDay,
  readMinTimeGapMins,
} from "../lib/mailboxSendSettings.js";
import { mailboxMessagePerDayTarget } from "../lib/sendCeiling.js";
import {
  daysSince,
  isPrewarmedGeneric,
  isWarmupGateExempt,
  tagNames,
  warmupClockStartedAt,
} from "./warmupGate.js";
import { isExcluded } from "./campaignTopUp.js";
import { type InventoryBook, type InventorySnapshot } from "./inventory.js";
import {
  detectSentMergeHoles,
  extractCampaignLeads,
  extractLeadTotal,
  extractMergeTags,
  extractSentBodies,
  extractSequenceMergeTags,
  formatMergeTagFinding,
  judgeMergeTagFill,
  leadInventoryGrew,
  MERGE_TAG_SAMPLE_PAGE,
  MERGE_TAG_SAMPLE_PAGES,
  MERGE_TAG_SENT_SAMPLE,
  sampleLeadOffsets,
} from "../lib/mergeTags.js";

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
 * hourly sweeps watch pod/shell, signatures, canaries, the half-client
 * floor, and merge-tag fill (D180). Bounce auto-pause is not this checker.
 */
export class CampaignCheckService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly state: StateStore,
    private readonly book: InventoryBook,
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

    // D132 — a check without a handed-down snapshot reads the shared book.
    const { campaigns, accounts, clients } =
      opts.inventory ?? (await this.book.get());
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
    const insightFixed: string[] = [];
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
      const openSigFinding = (record.findings ?? []).some(
        (finding) =>
          finding.startsWith("missing_signature_tag") ||
          finding.startsWith("missing_insight_close") ||
          finding.startsWith("mailbox_sig"),
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
      // D180 — first-check always samples; hourly resample of first-passed
      // ACTIVE campaigns that use custom tags. Leftover signature-only
      // inspects carry the last finding forward unless the lead list grew.
      const sampleMergeTags = runFirst || hourlySweep || mode === "all";
      const inspected = await this.inspect({
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
        sampleMergeTags,
        priorMergeTagLeadTotal: record.mergeTagLeadTotal,
        priorMergeTagFindings: (record.findings ?? []).filter((finding) =>
          finding.startsWith("merge_tag_blank"),
        ),
      });
      let findings = inspected.findings;
      // D138 — the campaign-level minimum gap is converged, not assumed.
      // Mailbox-level 10m is converged every pass by mailbox-settings; a
      // hand-made campaign arrives on Smartlead's default and nothing else
      // guarded this knob (live 2026-08-26: settings clean, but only by
      // setup discipline). Fix on sight; keep the finding only on failure.
      if (
        ["ACTIVE", "START"].includes(
          String(campaign.status ?? "").toUpperCase(),
        ) &&
        !isAnyShellCampaign(campaign)
      ) {
        const rawGap = (
          campaign as { min_time_btwn_emails?: number | string | null }
        ).min_time_btwn_emails;
        const gapMins =
          typeof rawGap === "string" ? Number(rawGap) : rawGap ?? Number.NaN;
        const gapFloor = this.config.mailboxMinTimeGapMins;
        if (!(typeof gapMins === "number" && Number.isFinite(gapMins) && gapMins >= gapFloor)) {
          const detail = `${rawGap ?? "unset"} → ${gapFloor}m`;
          if (this.config.dryRun) {
            findings.push({ kind: "campaign_min_gap", detail });
          } else {
            try {
              await this.smartlead.updateCampaignSettings(
                campaign.id,
                campaignSettingsWriteBody({}, { min_time_btwn_emails: gapFloor }),
              );
              await sleep(WRITE_GAP_MS);
              console.log(
                `[campaign-check] ${kind} #${campaign.id} ${name} — campaign min gap ${detail} (D138)`,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              findings.push({
                kind: "campaign_min_gap",
                detail: `${detail} failed: ${message}`,
              });
            }
          }
        }
      }
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
        sequences: inspected.sequences,
        accounts: accounts as SmartleadAccountWithCampaigns[],
        findings,
        otherClientBrands: allBrands,
      });
      if (sigApplied) {
        if (sigApplied.wroteTag) {
          findings = findings.filter(
            (finding) => finding.kind !== "missing_signature_tag",
          );
        }
        if (sigApplied.wroteInsightClose) {
          findings = findings.filter(
            (finding) => finding.kind !== "missing_insight_close",
          );
        }
        if (sigApplied.wroteMailbox) {
          findings = findings.filter((finding) => finding.kind !== "mailbox_sig");
        }
        // D178 — Insight-in-copy never rewrites shared mailbox fields.
        if (sigApplied.skipMailbox) {
          findings = findings.filter((finding) => finding.kind !== "mailbox_sig");
        }
        // D95 — tell Josh the first time we write a campaign. A leftover
        // backfill already notified does not ping again every pass.
        if (sigApplied.wroteTag && !record.sigAutoWrittenAt) {
          sigFixed.push({ name, brand: sigApplied.brand });
        }
        if (sigApplied.wroteInsightClose && !record.sigAutoWrittenAt) {
          insightFixed.push(name);
        }
      }
      const passed = firstCheckPassed(findings);
      const next: CampaignCheckRecord = {
        ...record,
        name,
        lastKind: kind,
        findings: findings.map(formatFinding),
        sigAutoWrittenAt:
          sigApplied?.wroteTag || sigApplied?.wroteInsightClose
            ? now
            : record.sigAutoWrittenAt,
        mergeTagCheckedAt: inspected.mergeTagCheckedAt ?? record.mergeTagCheckedAt,
        mergeTagLeadTotal: inspected.mergeTagLeadTotal ?? record.mergeTagLeadTotal,
        mergeTagCustomKeys:
          inspected.mergeTagCustomKeys ?? record.mergeTagCustomKeys,
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
    if (insightFixed.length && this.slack) {
      await this.slack.notifyActionResult(
        [
          `I wrote Josh Osborn / Insight into the sequence copy on ${insightFixed.length} campaign${insightFixed.length === 1 ? "" : "s"} (before the P.S.). Mailbox signatures were not changed:`,
          ...insightFixed.map((row) => `• ${row}`),
        ].join("\n"),
      );
    } else if (insightFixed.length) {
      console.log(
        `[campaign-check] insight closes written=${insightFixed.length} (no Slack client)`,
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
   * D31 / D92 / D98 — missing `%signature%` is written, and any mailbox
   * on the campaign that is not the two-line Name / Brand rule is set
   * to that pair. Slack once per campaign the first time we append the
   * tag (D95). A mailbox-only leftover logs; it does not page (D71).
   *
   * D178 — copy containing `Insight` does not get a mailbox placeholder
   * and never rewrites shared mailbox signature fields. The close
   * `Josh Osborn` / `Insight` is written into the sequence body
   * before any P.S. lines.
   */
  private async autoApplySignature(input: {
    campaignId: number;
    name: string;
    brand: string;
    sequences: SmartleadSequence[] | null;
    accounts: SmartleadAccountWithCampaigns[];
    findings: CampaignFinding[];
    otherClientBrands: string[];
  }): Promise<{
    brand: string;
    wroteTag: boolean;
    wroteMailbox: boolean;
    wroteInsightClose: boolean;
    skipMailbox: boolean;
  } | null> {
    const needTag = input.findings.some(
      (finding) => finding.kind === "missing_signature_tag",
    );
    const needMailbox = input.findings.some(
      (finding) => finding.kind === "mailbox_sig",
    );
    let sequences = input.sequences;
    const insightInCopy = sequenceBodiesContainInsight(sequences);
    const needInsight =
      insightInCopy &&
      (sequencesHaveSignaturePlaceholder(sequences) ||
        sequencesNeedInsightClose(sequences) ||
        input.findings.some((finding) => finding.kind === "missing_insight_close"));
    if (!needTag && !needMailbox && !needInsight) {
      return null;
    }
    if (this.config.dryRun) {
      console.log(
        `[campaign-check] dry-run signature #${input.campaignId} ${input.name}`,
      );
      return {
        brand: input.brand,
        wroteTag: needTag && !insightInCopy,
        wroteMailbox: needMailbox && !insightInCopy,
        wroteInsightClose: needInsight,
        skipMailbox: insightInCopy,
      };
    }
    try {
      let wroteTag = false;
      let wroteInsightClose = false;
      if (sequences == null && (needTag || insightInCopy || needInsight)) {
        sequences = await this.smartlead.getCampaignSequences(input.campaignId);
      }
      const rows = sequences ?? [];
      if (sequenceBodiesContainInsight(rows)) {
        const { sequences: next, changed } = ensureInsightCloseOnSequences(rows);
        if (changed.length) {
          await this.smartlead.updateCampaignSequences(input.campaignId, next);
          await sleep(WRITE_GAP_MS);
          wroteInsightClose = true;
          console.log(
            `[campaign-check] insight close written #${input.campaignId} ${input.name} ${changed.join(", ")} (D178)`,
          );
        }
      } else if (needTag) {
        const { sequences: next, changed } = appendSignatureTag(rows);
        if (changed.length) {
          await this.smartlead.updateCampaignSequences(input.campaignId, next);
          await sleep(WRITE_GAP_MS);
          wroteTag = true;
        }
      }
      let wroteMailbox = false;
      // D178 — Insight campaigns share SalesGlider mailboxes. Never
      // rewrite those email-account signature fields from this path.
      if (!sequenceBodiesContainInsight(rows)) {
        for (const account of input.accounts) {
          if (!campaignIdsOf(account).includes(input.campaignId)) continue;
          const desired = desiredMailboxSignature({
            fromName: account.from_name,
            signature: account.signature,
            clientBrand: input.brand,
            otherClientBrands: input.otherClientBrands,
          });
          if (!desired) continue;
          const actual = extractSignatureLines(account.signature).join("\n");
          const want = extractSignatureLines(desired).join("\n");
          if (actual === want) continue;
          if (typeof account.id !== "number") continue;
          await this.smartlead.updateEmailAccount(account.id, { signature: desired });
          await sleep(WRITE_GAP_MS);
          wroteMailbox = true;
        }
      }
      console.log(
        `[campaign-check] signature written #${input.campaignId} ${input.name} brand=${input.brand || "unknown"} tag=${wroteTag} mailbox=${wroteMailbox} insightClose=${wroteInsightClose}`,
      );
      return {
        brand: input.brand,
        wroteTag,
        wroteMailbox,
        wroteInsightClose,
        skipMailbox: sequenceBodiesContainInsight(rows),
      };
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
    sampleMergeTags: boolean;
    priorMergeTagLeadTotal?: number | null;
    priorMergeTagFindings?: string[];
  }): Promise<{
    findings: CampaignFinding[];
    sequences: SmartleadSequence[] | null;
    mergeTagCheckedAt?: string | null;
    mergeTagLeadTotal?: number | null;
    mergeTagCustomKeys?: string[];
  }> {
    const findings: CampaignFinding[] = [];
    const { campaign } = input;
    const name = String(campaign.name ?? campaign.id);
    const status = String(campaign.status ?? "").toUpperCase();
    const shell = isAnyShellCampaign(campaign);
    const excluded = isExcluded(campaign, this.config.topUpExcludeCampaigns);

    if (shell) {
      if (status !== "PAUSED") {
        // D131 — a finding the sweep can close itself is closed, not
        // reported forever (D85). Shells must sit PAUSED (D56/D114).
        if (!this.config.dryRun) {
          try {
            await this.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
            await sleep(WRITE_GAP_MS);
            console.log(
              `[campaign-check] paused instrumentation shell #${campaign.id} ${name} (was ${status || "unknown"})`,
            );
            return { findings, sequences: null };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn(
              `[campaign-check] could not pause shell #${campaign.id}: ${message}`,
            );
          }
        }
        findings.push({
          kind: "shell_not_paused",
          detail: `instrumentation shell is ${status || "unknown"} — must stay PAUSED`,
        });
      }
      return { findings, sequences: null };
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

    const taggedClient = input.clients.find(
      (client) => client.id === campaign.client_id,
    );
    const clientName = clientDisplayName(taggedClient);
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
        const mismatch = mailboxSignatureMismatch({
          fromName: account.from_name,
          signature: account.signature,
          clientBrand: expected,
          otherClientBrands: input.allBrands,
        });
        if (mismatch) {
          findings.push({
            kind: "mailbox_sig",
            detail: `${email} ${mismatch}`,
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
          shell: other ? isAnyShellCampaign(other) : false,
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
          resting: Boolean(this.state.getRestingInbox(email.toLowerCase())),
        })
      ) {
        serving.push(email.toLowerCase());
      }
      if (
        !this.state.isCopyCanary(email) &&
        !isWarmupGateExempt(tagNames(account)) &&
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
      const wantVolume = mailboxMessagePerDayTarget(account, this.config);
      if (Number.isFinite(volume) && volume !== wantVolume) {
        findings.push({
          kind: "mailbox_volume",
          detail: `${email} ${volume}/day (want ${wantVolume})`,
        });
      }
    }

    let sequences: SmartleadSequence[] | null = null;
    try {
      sequences = await this.smartlead.getCampaignSequences(campaign.id);
      await sleep(WRITE_GAP_MS);
      const insightInCopy = sequenceBodiesContainInsight(sequences);
      if (insightInCopy) {
        for (let i = findings.length - 1; i >= 0; i--) {
          if (findings[i]!.kind === "mailbox_sig") findings.splice(i, 1);
        }
      }
      for (const row of sequenceCopyHay(sequences ?? [])) {
        if (insightInCopy) {
          if (
            row.text.replace(/<[^>]+>/g, " ").trim() &&
            !bodyHasInsightClose(row.text)
          ) {
            findings.push({
              kind: "missing_insight_close",
              detail: `${row.label} is missing Josh Osborn / Insight close`,
            });
          }
        } else if (missingSignatureTag(row.text)) {
          findings.push({
            kind: "missing_signature_tag",
            detail: `${row.label} is missing %signature%`,
          });
        }
        if (input.depth === "first" && expected) {
          const foreign = findForeignBrand(row.text, expected, input.allBrands);
          if (foreign && !(insightInCopy && /insight/i.test(foreign))) {
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

    const mergeTag = await this.inspectMergeTags({
      campaign,
      sequences,
      status,
      sampleMergeTags: input.sampleMergeTags,
      priorLeadTotal: input.priorMergeTagLeadTotal,
      priorFindings: input.priorMergeTagFindings ?? [],
    });
    findings.push(...mergeTag.findings);

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

    return {
      findings,
      sequences,
      mergeTagCheckedAt: mergeTag.checkedAt,
      mergeTagLeadTotal: mergeTag.leadTotal,
      mergeTagCustomKeys: mergeTag.customKeys,
    };
  }

  /**
   * D180 — sample custom {{tags}} against lead custom_fields and a
   * cheap sent-body page. Pages via the CANON-miss Slack contract;
   * never writes sequence copy or remaps leads.
   */
  private async inspectMergeTags(input: {
    campaign: SmartleadCampaign;
    sequences: SmartleadSequence[] | null;
    status: string;
    sampleMergeTags: boolean;
    priorLeadTotal?: number | null;
    priorFindings: string[];
  }): Promise<{
    findings: CampaignFinding[];
    checkedAt?: string | null;
    leadTotal?: number | null;
    customKeys?: string[];
  }> {
    const { campaign, sequences } = input;
    if (isAnyShellCampaign(campaign) || !sequences?.length) {
      return { findings: [] };
    }
    const extracted = extractSequenceMergeTags(sequences);
    if (!extracted.customTags.length) {
      return { findings: [], customKeys: [], leadTotal: input.priorLeadTotal ?? null };
    }
    if (typeof this.smartlead.getCampaignLeads !== "function") {
      return {
        findings: carryMergeTagFindings(input.priorFindings),
        customKeys: extracted.customTags,
        leadTotal: input.priorLeadTotal ?? null,
      };
    }

    let total = 0;
    const sending = ["ACTIVE", "START"].includes(input.status);
    if (!input.sampleMergeTags) {
      try {
        const peek = await this.smartlead.getCampaignLeads(campaign.id, {
          limit: 1,
          offset: 0,
        });
        await sleep(WRITE_GAP_MS);
        total = extractLeadTotal(peek);
      } catch (error) {
        console.warn(
          `[campaign-check] could not peek leads for merge-tag fill #${campaign.id}`,
          error,
        );
        return {
          findings: carryMergeTagFindings(input.priorFindings),
          customKeys: extracted.customTags,
          leadTotal: input.priorLeadTotal ?? null,
        };
      }
      if (!leadInventoryGrew(input.priorLeadTotal, total)) {
        return {
          findings: carryMergeTagFindings(input.priorFindings),
          customKeys: extracted.customTags,
          leadTotal: total || input.priorLeadTotal || null,
        };
      }
    }

    const leads: Array<Record<string, unknown>> = [];
    const firstSeenIn: Record<string, string> = {};
    for (const row of extracted.bodies) {
      for (const tag of extractMergeTags(row.text)) {
        if (firstSeenIn[tag] == null) firstSeenIn[tag] = row.label;
      }
    }
    // First page both samples and reveals total_leads so later offsets
    // are real (a guessed total of PAGE would collapse to offset 0).
    try {
      const firstPage = await this.smartlead.getCampaignLeads(campaign.id, {
        limit: MERGE_TAG_SAMPLE_PAGE,
        offset: 0,
      });
      await sleep(WRITE_GAP_MS);
      leads.push(...extractCampaignLeads(firstPage));
      total = extractLeadTotal(firstPage) || total || leads.length;
    } catch (error) {
      console.warn(
        `[campaign-check] merge-tag lead sample failed #${campaign.id} offset=0`,
        error,
      );
    }
    const offsets = sampleLeadOffsets(
      total,
      MERGE_TAG_SAMPLE_PAGE,
      MERGE_TAG_SAMPLE_PAGES,
    ).filter((offset) => offset > 0);
    for (const offset of offsets) {
      try {
        const page = await this.smartlead.getCampaignLeads(campaign.id, {
          limit: MERGE_TAG_SAMPLE_PAGE,
          offset,
        });
        await sleep(WRITE_GAP_MS);
        leads.push(...extractCampaignLeads(page));
      } catch (error) {
        console.warn(
          `[campaign-check] merge-tag lead sample failed #${campaign.id} offset=${offset}`,
          error,
        );
      }
    }

    const fills = judgeMergeTagFill({
      tags: extracted.customTags,
      leads,
      firstSeenIn,
    });

    let holes: ReturnType<typeof detectSentMergeHoles> = [];
    if (
      sending &&
      typeof this.smartlead.getCampaignStatistics === "function"
    ) {
      try {
        const stats = await this.smartlead.getCampaignStatistics(campaign.id, {
          limit: MERGE_TAG_SENT_SAMPLE,
          offset: 0,
        });
        await sleep(WRITE_GAP_MS);
        holes = detectSentMergeHoles({
          sentBodies: extractSentBodies(stats),
          customTags: extracted.customTags,
          sequenceTexts: extracted.bodies.map((row) => row.text),
        });
      } catch (error) {
        console.warn(
          `[campaign-check] merge-tag sent-body sample failed #${campaign.id}`,
          error,
        );
      }
    }

    const detail = formatMergeTagFinding({ fills, holes });
    const findings: CampaignFinding[] = detail
      ? [{ kind: "merge_tag_blank", detail }]
      : [];
    return {
      findings,
      checkedAt: new Date().toISOString(),
      leadTotal: total || leads.length,
      customKeys: extracted.customTags,
    };
  }
}

function carryMergeTagFindings(prior: string[]): CampaignFinding[] {
  const out: CampaignFinding[] = [];
  for (const finding of prior) {
    if (!finding.startsWith("merge_tag_blank:")) continue;
    const detail = finding.slice("merge_tag_blank:".length).trim();
    if (detail) out.push({ kind: "merge_tag_blank", detail });
  }
  return out;
}
