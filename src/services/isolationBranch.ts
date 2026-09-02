import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { decideIsolationVerdict } from "../lib/isolationVerdict.js";
import {
  allEspsAtOrAbove,
  anyEspBelowThreshold,
  type ProviderInboxSplit,
} from "../lib/copySignal.js";
import { campaignProof } from "../lib/isolationProof.js";
import { nyDateLabel } from "../lib/campaignDayStats.js";
import type { IsolationRunRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  isCanaryCopyTestName,
  isIsolationManagedTestName,
} from "../lib/isolationNames.js";
import {
  isTerminalIsolationVerdict,
  liveCampaignForPlacementTrigger,
  placementSuspectReason,
  sameEspInboxUgly,
  shouldQueuePlacementSuspect,
} from "../lib/placementSuspect.js";
import { isExcluded } from "./campaignTopUp.js";
import type { CopyIsolationService } from "./copyIsolation.js";
import type { IsolationRigService } from "./isolationRig.js";
import type { CopyCanaryService } from "./copyCanary.js";

export interface IsolationBranchResult {
  dryRun: boolean;
  evaluated: number;
  copy: number;
  infra: number;
  inconclusive: number;
  teardowns: number;
  errors: string[];
}

export class IsolationBranchService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly copyIsolation: CopyIsolationService,
    private readonly rig: IsolationRigService,
    private readonly copyCanary?: CopyCanaryService,
  ) {}

  async run(opts: { dryRun?: boolean; campaignId?: number } = {}): Promise<IsolationBranchResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: IsolationBranchResult = {
      dryRun,
      evaluated: 0,
      copy: 0,
      infra: 0,
      inconclusive: 0,
      teardowns: 0,
      errors: [],
    };
    if (!this.config.enableIsolationBranch) return result;

    if (!opts.campaignId) {
      await this.queueUglyPlacementSuspects();
    }

    const targets = opts.campaignId
      ? [{ campaignId: opts.campaignId }]
      : this.state.listCopySuspects().filter((row) => !row.evaluatedAt);

    for (const target of targets) {
      try {
        const run = await this.evaluate(target.campaignId, {
          dryRun,
          campaignInSpam: true,
        });
        result.evaluated += 1;
        if (run.verdict === "COPY") result.copy += 1;
        else if (run.verdict === "INFRA") result.infra += 1;
        else result.inconclusive += 1;
        if (run.teardownStarted) result.teardowns += 1;
        const prior = this.state
          .listCopySuspects()
          .find((row) => row.campaignId === target.campaignId);
        this.state.markCopySuspect({
          campaignId: target.campaignId,
          campaignName: run.campaignName,
          at: prior?.at ?? new Date().toISOString(),
          reason: prior?.reason,
          // INCONCLUSIVE stays queued so a later canary/known-good reading can finish the branch.
          evaluatedAt: isTerminalIsolationVerdict(run.verdict)
            ? new Date().toISOString()
            : prior?.evaluatedAt,
        });
      } catch (error) {
        result.errors.push(
          `#${target.campaignId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.state.save();
    return result;
  }

  async evaluate(
    campaignId: number,
    opts: { dryRun?: boolean; campaignInSpam?: boolean; silent?: boolean } = {},
  ): Promise<IsolationRunRecord> {
    const campaign = await this.smartlead.getCampaign(campaignId);
    if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
      const skipped: IsolationRunRecord = {
        id: randomUUID(),
        campaignId,
        campaignName: campaign.name,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        control: "INSUFFICIENT",
        verdict: "INCONCLUSIVE",
        campaignInSpam: false,
        reason: "Campaign is on the leave-alone list.",
      };
      this.state.upsertIsolationRun(skipped);
      return skipped;
    }

    const accounts = await this.smartlead.getCampaignEmailAccounts(campaignId);
    const emails = accounts
      .map((account) => accountEmail(account)?.toLowerCase())
      .filter((email): email is string => Boolean(email));
    const senderControls = emails.map(
      (email) => this.state.getMailboxControl(email)?.placement ?? "UNKNOWN",
    );
    const campaignInSpam =
      opts.campaignInSpam ?? (await this.campaignLooksSpam(campaignId));
    const knownGoodFineAcrossEsps = await this.knownGoodFineAcrossEsps(emails);
    const unwarmedCopyFineAcrossEsps =
      await this.unwarmedCopyFineAcrossEsps(campaignId);
    const rigPrimary = await this.rig.readLatestControl();
    const copyCanarySplit = this.copyCanary
      ? await this.copyCanary.readSplit(campaignId)
      : null;
    const decided = decideIsolationVerdict({
      campaignInSpam,
      senderControls,
      knownGoodFineAcrossEsps,
      unwarmedCopyFineAcrossEsps,
      copyCanary: copyCanarySplit,
      rig:
        decidedNeedsRig(campaignInSpam, senderControls)
          ? { controlPrimary: rigPrimary, copyPrimary: null }
          : undefined,
    });

    let infraCheck: Record<string, unknown> | undefined;
    if (decided.pullInfraDiagnostics) {
      infraCheck = await this.infraFromLatestControl(emails);
    }

    const run: IsolationRunRecord = {
      id: randomUUID(),
      campaignId,
      campaignName: campaign.name,
      client: campaign.name,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      control: decided.control,
      verdict: decided.verdict,
      campaignInSpam,
      reason: decided.reason,
      infraCheck,
      teardownStarted: false,
    };
    this.state.upsertIsolationRun(run);

    if (
      decided.startCopyTeardown &&
      this.config.enableCopyIsolation &&
      !opts.dryRun
    ) {
      const teardown = await this.copyIsolation.runForCampaign(run);
      run.teardownStarted = teardown.started || teardown.waiting;
      run.updatedAt = new Date().toISOString();
      this.state.upsertIsolationRun(run);
    }

    const canaryLine = this.copyCanary?.describeSplit(copyCanarySplit);
    const proof = campaignProof({
      verdict: decided.verdict,
      controlVersion: this.state.getIsolation().controlTemplate?.controlVersion,
      senderSummary: `${emails.length} inbox${emails.length === 1 ? "" : "es"} on this campaign`,
      whyNotTheOther: [
        whyNotTheOtherCause(decided.verdict, decided.reason),
        canaryLine,
      ]
        .filter(Boolean)
        .join(" "),
      next:
        decided.verdict === "COPY"
          ? "I will not edit the live email until Josh or Cayden tap Make the changes."
          : decided.verdict === "INFRA"
            ? "I will not rewrite the email. Domain retire or a replacement buy still waits for Josh."
            : "I will keep testing. A campaign in spam is a flag, not a domain death sentence.",
    });
    run.notes = proof;
    this.state.upsertIsolationRun(run);

    // D69 — a COPY guess is not Slack-worthy. Canaries + word hunt post
    // once, with the word and a one-click edit.
    if (!opts.silent && decided.verdict !== "COPY") {
      await this.slack.notifyIsolationVerdict({
        campaignName: campaign.name,
        clientName: campaign.name,
        dateLabel: nyDateLabel(),
        verdict: decided.verdict,
        reason: decided.reason,
        teardownStarted: run.teardownStarted,
        infraSummary: summarizeInfra(infraCheck),
        proof,
      });
    }
    await this.state.save();
    return run;
  }

  /**
   * D158 — canary-copy or live placement same-ESP under the live 80% bar
   * queues the ACTIVE campaign as a copy suspect. Isolation then decides
   * COPY vs INFRA. Not a Slack page (D71).
   */
  async queueUglyPlacementSuspects(): Promise<number> {
    let campaigns: Awaited<ReturnType<SmartleadClient["listCampaigns"]>> = [];
    try {
      campaigns = await this.smartlead.listCampaigns();
    } catch (error) {
      console.warn("[isolation-branch] could not list campaigns for placement queue", error);
      return 0;
    }

    const tests = normalizeTestList(
      await this.smartDelivery.listTests({}).catch(() => []),
    );
    let queued = 0;
    const seen = new Set<number>();

    for (const test of tests) {
      const target = liveCampaignForPlacementTrigger({
        testName: test.test_name,
        testCampaignId: campaignIdOf(test),
        campaigns,
      });
      if (!target) continue;
      if (seen.has(target.campaignId)) continue;
      const campaign = campaigns.find((row) => row.id === target.campaignId);
      if (
        !campaign ||
        isExcluded(campaign, this.config.topUpExcludeCampaigns) ||
        isAnyShellCampaign(campaign)
      ) {
        continue;
      }
      if (
        !shouldQueuePlacementSuspect({
          existing: this.state
            .listCopySuspects()
            .find((row) => row.campaignId === target.campaignId),
          openRun: this.state.latestIsolationRunForCampaign(target.campaignId),
        })
      ) {
        continue;
      }

      const tid = testIdOf(test);
      if (!tid) continue;
      if (
        isIsolationManagedTestName(test.test_name) &&
        !isCanaryCopyTestName(test.test_name)
      ) {
        continue;
      }
      const splits = await this.providerSplits(tid);
      if (!sameEspInboxUgly(splits, this.config.remediationInboxThreshold)) {
        continue;
      }

      seen.add(target.campaignId);
      this.state.markCopySuspect({
        campaignId: target.campaignId,
        campaignName: target.campaignName ?? campaign.name,
        at: new Date().toISOString(),
        reason: placementSuspectReason(
          target.source,
          splits,
          this.config.remediationInboxThreshold,
        ),
      });
      queued += 1;
      console.log(
        `[isolation-branch] queued #${target.campaignId} from ${target.source}: ${splits
          .map((row) => `${row.name} ${row.inboxPercent.toFixed(0)}%`)
          .join(", ")}`,
      );
    }
    return queued;
  }

  private async campaignLooksSpam(campaignId: number): Promise<boolean> {
    const tests = await this.smartDelivery.listTests({}).catch(() => []);
    const mine = tests.filter((test) => campaignIdOf(test) === String(campaignId));
    const latest = mine.sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )[0];
    if (!latest) return true;
    const tid = latest.spam_test_id ?? latest.id;
    if (tid != null) {
      const splits = await this.providerSplits(String(tid));
      if (splits.length) {
        return anyEspBelowThreshold(
          splits,
          this.config.remediationInboxThreshold,
        );
      }
    }
    const spam = Number(latest.spam_count ?? 0);
    const inbox = Number(latest.inbox_count ?? 0);
    const total = spam + inbox + Number(latest.tab_count ?? 0);
    if (total <= 0) return true;
    return inbox / total * 100 < this.config.remediationInboxThreshold;
  }

  /** D96 — unwarmed fleet sending this campaign copy, every scored ESP. */
  private async unwarmedCopyFineAcrossEsps(
    campaignId: number,
  ): Promise<boolean | null> {
    const testId = this.state.getCopyCanaryTestId(campaignId);
    if (!testId) return null;
    const splits = await this.providerSplits(String(testId));
    if (!splits.length) return null;
    return allEspsAtOrAbove(splits, this.config.remediationInboxThreshold);
  }

  /** D93 — known-good on these domains, every scored ESP at/above 80%. */
  private async knownGoodFineAcrossEsps(
    emails: string[],
  ): Promise<boolean | null> {
    const wanted = new Set(emails.map((email) => email.toLowerCase()));
    const controls = this.state
      .listPodControls()
      .filter((row) =>
        row.emails.some((email) => wanted.has(email.toLowerCase())),
      );
    if (!controls.length) return null;
    let scored = false;
    for (const row of controls) {
      if (!row.spamTestId) continue;
      const splits = await this.providerSplits(row.spamTestId);
      if (!splits.length) continue;
      scored = true;
      if (allEspsAtOrAbove(splits, this.config.remediationInboxThreshold) === false) {
        return false;
      }
    }
    return scored ? true : null;
  }

  private async providerSplits(testId: string): Promise<ProviderInboxSplit[]> {
    try {
      const report = await this.smartDelivery.getProviderwiseReport(testId);
      const rows = Array.isArray(report?.result) ? report.result : [];
      const out: ProviderInboxSplit[] = [];
      for (const row of rows) {
        const name = String(row.provider_name ?? row.provider ?? "");
        const inbox = inboxPercentFromProvider(row);
        if (!name || inbox == null) continue;
        out.push({ name, inboxPercent: inbox });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async infraFromLatestControl(
    emails: string[],
  ): Promise<Record<string, unknown>> {
    const wanted = new Set(emails);
    const control = this.state
      .listPodControls()
      .find((row) => row.emails.some((email) => wanted.has(email.toLowerCase())));
    if (!control) return {};
    const testId = control.spamTestId;
    const [ip, domain, dkim, spf, rdns, ipAnalytics] = await Promise.all([
      this.smartDelivery.getIpBlacklist(testId).catch(() => null),
      this.smartDelivery.getDomainBlacklist(testId).catch(() => null),
      this.smartDelivery.getDkimDetails(testId).catch(() => null),
      this.smartDelivery.getSpfDetails(testId).catch(() => null),
      this.smartDelivery.getRdnsDetails(testId).catch(() => null),
      this.smartDelivery.getIpAnalytics(testId).catch(() => null),
    ]);
    return {
      testId,
      ipHits: parseIpBlacklistHits(ip ?? []).length,
      domainHits: parseDomainBlacklistHits(domain).length,
      dkim,
      spf,
      rdns,
      ipAnalytics,
    };
  }
}

function inboxPercentFromProvider(row: {
  inbox_rate?: number;
  inbox_count?: number;
  tab_count?: number;
  spam_count?: number;
  adjusted_total_email_count?: number;
  total_email_count?: number;
}): number | null {
  if (typeof row.inbox_rate === "number" && Number.isFinite(row.inbox_rate)) {
    return row.inbox_rate <= 1 ? row.inbox_rate * 100 : row.inbox_rate;
  }
  const inbox = row.inbox_count ?? 0;
  const tab = row.tab_count ?? 0;
  const spam = row.spam_count ?? 0;
  const total =
    row.adjusted_total_email_count ??
    row.total_email_count ??
    inbox + tab + spam;
  if (!total) return null;
  return (inbox / total) * 100;
}

function decidedNeedsRig(
  campaignInSpam: boolean,
  senderControls: Array<"PRIMARY" | "SPAM" | "OTHER" | "UNKNOWN">,
): boolean {
  return (
    campaignInSpam &&
    senderControls.some((placement) => placement === "PRIMARY") &&
    !senderControls.some((placement) => placement === "SPAM")
  );
}

function whyNotTheOtherCause(
  verdict: IsolationRunRecord["verdict"],
  reason: string,
): string {
  if (verdict === "COPY") {
    return "Why not the inboxes: known-good on those domains landed across ESPs, and unwarmed senders with that same copy also failed an ESP.";
  }
  if (verdict === "INFRA") {
    return "Why not the copy: either the known-good email on those domains failed an ESP, or unwarmed senders landed that campaign copy — rewriting the live email will not fix this.";
  }
  if (verdict === "HEALTHY") {
    return "Why nothing is broken: the campaign test and the known-good email both look fine.";
  }
  return `Why I will not pick a cause yet: ${reason}`;
}

function summarizeInfra(infra?: Record<string, unknown>): string | undefined {
  if (!infra) return undefined;
  const ipHits = Number(infra.ipHits ?? 0);
  const domainHits = Number(infra.domainHits ?? 0);
  if (!ipHits && !domainHits) {
    return "Inbox diagnostics did not name a blacklist. Check authentication on the standing test.";
  }
  return `Inbox diagnostics: ${ipHits} IP listing${ipHits === 1 ? "" : "s"}, ${domainHits} domain listing${domainHits === 1 ? "" : "s"}.`;
}

