import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  campaignIdOf,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { decideIsolationVerdict } from "../lib/isolationVerdict.js";
import { campaignProof } from "../lib/isolationProof.js";
import { nyDateLabel } from "../lib/campaignDayStats.js";
import type { IsolationRunRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
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

    const targets = opts.campaignId
      ? [{ campaignId: opts.campaignId }]
      : this.state.listCopySuspects().filter((row) => !row.evaluatedAt);

    for (const target of targets) {
      try {
        const run = await this.evaluate(target.campaignId, { dryRun });
        result.evaluated += 1;
        if (run.verdict === "COPY") result.copy += 1;
        else if (run.verdict === "INFRA") result.infra += 1;
        else result.inconclusive += 1;
        if (run.teardownStarted) result.teardowns += 1;
        this.state.markCopySuspect({
          campaignId: target.campaignId,
          campaignName: run.campaignName,
          at: this.state.listCopySuspects().find((row) => row.campaignId === target.campaignId)?.at
            ?? new Date().toISOString(),
          evaluatedAt: new Date().toISOString(),
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
    const rigPrimary = await this.rig.readLatestControl();
    const copyCanarySplit = this.copyCanary
      ? await this.copyCanary.readSplit(campaignId)
      : null;
    const decided = decideIsolationVerdict({
      campaignInSpam,
      senderControls,
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
          ? "I will not edit the live email until Josh or Cayden tap Switch the word."
          : decided.verdict === "INFRA"
            ? "I will not rewrite the email. Domain retire or a replacement buy still waits for Josh."
            : "I will keep testing. A campaign in spam is a flag, not a domain death sentence.",
    });
    run.notes = proof;
    this.state.upsertIsolationRun(run);

    if (!opts.silent) {
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

  private async campaignLooksSpam(campaignId: number): Promise<boolean> {
    const tests = await this.smartDelivery.listTests({}).catch(() => []);
    const mine = tests.filter((test) => campaignIdOf(test) === String(campaignId));
    const latest = mine.sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )[0];
    if (!latest) return true;
    const spam = Number(latest.spam_count ?? 0);
    const inbox = Number(latest.inbox_count ?? 0);
    const total = spam + inbox + Number(latest.tab_count ?? 0);
    if (total <= 0) return true;
    return inbox / total * 100 < this.config.remediationInboxThreshold;
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
    return "Why not the inboxes: the same inboxes landed the known-good email (no offer, no link, no spam words).";
  }
  if (verdict === "INFRA") {
    return "Why not the copy: the known-good email from those same inboxes also landed in spam, so rewriting the campaign will not fix this.";
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

