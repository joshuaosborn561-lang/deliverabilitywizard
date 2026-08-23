import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  pickSequence,
  sequenceSubjectPreview,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  flaggedTermsFromSpamFilter,
  parseCampaignEmailContent,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { htmlFromPlain } from "../lib/controlTemplate.js";
import {
  generateCopyVariants,
  rankVariants,
  stripHtml,
  type CopyVariant,
} from "../lib/copyVariants.js";
import { ISOLATION_FOLDER_NAME, isolationVariantTestName } from "../lib/isolationNames.js";
import { copySequence, isolationManualPayload } from "../lib/isolationPlacement.js";
import { confirmSuppressedTerm } from "../lib/suppressedTerms.js";
import { CONTROL_PRIMARY_THRESHOLD } from "../lib/mailboxControlTag.js";
import { copySwapProof } from "../lib/isolationProof.js";
import {
  buildIsolationAction,
  requestIsolationAction,
  suggestedCopySwap,
} from "../lib/isolationActions.js";
import type { IsolationRunRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import type { IsolationRigService } from "./isolationRig.js";

export interface CopyIsolationResult {
  dryRun: boolean;
  started: boolean;
  waiting: boolean;
  missingRig: boolean;
  recovered: Array<{ element: string; kind: string }>;
  unchanged: string[];
  errors: string[];
}

export class CopyIsolationService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly rig: IsolationRigService,
  ) {}

  async runForCampaign(
    run: IsolationRunRecord,
    opts: { dryRun?: boolean } = {},
  ): Promise<CopyIsolationResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CopyIsolationResult = {
      dryRun,
      started: false,
      waiting: false,
      missingRig: false,
      recovered: [],
      unchanged: [],
      errors: [],
    };

    if (!this.config.enableCopyIsolation) return result;

    const existing = this.state.listIsolationVariants(run.id);
    if (existing.length) {
      return this.score(run, existing, result);
    }

    const emails = await this.rig.rigEmails();
    if (!emails.length) {
      result.missingRig = true;
      await this.slack.notifyCopyIsolation({
        campaignName: run.campaignName ?? `Campaign ${run.campaignId}`,
        missingRig: true,
      });
      return result;
    }

    const copy = await this.loadCampaignCopy(run.campaignId, run.suspectTestId);
    if (!copy.body) {
      result.errors.push(`no copy for campaign ${run.campaignId}`);
      return result;
    }

    const flagged = run.suspectTestId
      ? flaggedTermsFromSpamFilter(
          await this.smartDelivery
            .getSpamFilterDetails(run.suspectTestId)
            .catch(() => []),
        )
      : [];
    const variants = rankVariants(
      generateCopyVariants({
        subject: copy.subject ?? "",
        body: copy.body,
        flaggedTerms: flagged,
        suppressedTerms: this.state
          .listSuppressedTerms()
          .filter((term) => term.status === "confirmed")
          .map((term) => term.term),
        controlSubject: this.state.getIsolation().controlTemplate?.subject ?? "Quick check-in",
        companyName: run.client,
      }),
      flagged,
      this.config.isolationVariantCap,
    );

    if (!variants.length) {
      result.errors.push("no single-variable variants");
      return result;
    }

    const folderId = this.state.getIsolation().folders.teardowns;
    const created = dryRun
      ? variants.map((variant, index) =>
          this.recordVariant(run, variant, `dry-run-${index}`),
        )
      : await Promise.all(
          variants.map(async (variant, index) => {
            const createdTest = await this.smartDelivery.createManualPlacement(
              isolationManualPayload({
                testName: isolationVariantTestName(
                  run.campaignId,
                  variant.kind,
                  index,
                ),
                description: [
                  `${ISOLATION_FOLDER_NAME} — one variable only.`,
                  `Campaign ${run.campaignId}`,
                  `${variant.kind}: ${variant.element}`,
                ].join("\n"),
                senderAccounts: emails,
                sequence: copySequence(
                  "Isolation variant",
                  variant.subject,
                  /<[a-z][\s\S]*>/i.test(variant.body)
                    ? variant.body
                    : htmlFromPlain(variant.body),
                ),
                folderId,
                providerIds: this.config.providerIds,
                linkChecker: variant.kind === "link" ? false : true,
              }),
            );
            return this.recordVariant(run, variant, String(createdTest.id));
          }),
        );

    result.started = true;
    result.waiting = true;
    this.state.upsertIsolationRun({
      ...run,
      teardownStarted: true,
      seedsConsumed: (run.seedsConsumed ?? 0) + created.length,
      updatedAt: new Date().toISOString(),
    });
    await this.state.save();
    await this.slack.notifyCopyIsolation({
      campaignName: run.campaignName ?? `Campaign ${run.campaignId}`,
      waiting: true,
    });
    return result;
  }

  private recordVariant(
    run: IsolationRunRecord,
    variant: CopyVariant,
    spamTestId: string,
  ) {
    const record = {
      id: randomUUID(),
      runId: run.id,
      campaignId: run.campaignId,
      kind: variant.kind,
      element: variant.element,
      subject: variant.subject,
      body: variant.body,
      spamTestId,
      createdAt: new Date().toISOString(),
    };
    this.state.upsertIsolationVariant(record);
    return record;
  }

  private async score(
    run: IsolationRunRecord,
    variants: ReturnType<StateStore["listIsolationVariants"]>,
    result: CopyIsolationResult,
  ): Promise<CopyIsolationResult> {
    let pending = 0;
    for (const variant of variants) {
      if (!variant.spamTestId || variant.spamTestId.startsWith("dry-run")) {
        continue;
      }
      if (variant.recovered !== undefined) {
        if (variant.recovered) {
          result.recovered.push({ element: variant.element, kind: variant.kind });
        } else {
          result.unchanged.push(variant.element);
        }
        continue;
      }
      try {
        const report = await this.smartDelivery.getProviderwiseReport(
          variant.spamTestId,
        );
        const { primary, spam, samples } = providerSplit(report.result ?? []);
        if (samples === 0) {
          pending += 1;
          continue;
        }
        const recovered = primary >= CONTROL_PRIMARY_THRESHOLD && spam < 50;
        this.state.upsertIsolationVariant({
          ...variant,
          primaryPct: primary,
          spamPct: spam,
          recovered,
        });
        if (recovered) {
          result.recovered.push({ element: variant.element, kind: variant.kind });
          this.state.upsertSuppressedTerm(
            confirmSuppressedTerm(
              this.state
                .listSuppressedTerms()
                .find((term) => term.term.toLowerCase() === variant.element.toLowerCase()),
              {
                term: variant.element,
                kind: variant.kind,
                at: new Date().toISOString(),
                recoveredPlacementDelta: primary,
                clientScope: run.client,
              },
            ),
          );
        } else {
          result.unchanged.push(variant.element);
        }
      } catch {
        pending += 1;
      }
    }

    if (pending && !result.recovered.length && !result.unchanged.length) {
      result.waiting = true;
      return result;
    }

    await this.slack.notifyCopyIsolation({
      campaignName: run.campaignName ?? `Campaign ${run.campaignId}`,
      recovered: result.recovered,
      unchanged: result.unchanged,
      noneRecovered: !result.recovered.length && !pending,
    });
    const winner = result.recovered[0];
    if (winner) {
      const swap = suggestedCopySwap(winner.element);
      const proof = copySwapProof({
        campaignName: run.campaignName ?? `Campaign ${run.campaignId}`,
        element: winner.element,
        swap,
        controlLanded: run.control === "CLEAN",
      });
      await requestIsolationAction({
        store: this.state,
        slack: this.slack,
        action: buildIsolationAction({
          kind: "swap_copy",
          title: `Switch “${winner.element}” on ${run.campaignName ?? run.campaignId}`,
          proof,
          detail: {
            campaignId: run.campaignId,
            campaignName: run.campaignName,
            element: winner.element,
            swap,
          },
        }),
      });
    }
    await this.state.save();
    return result;
  }

  private async loadCampaignCopy(
    campaignId: number,
    suspectTestId?: string,
  ): Promise<{ subject?: string; body?: string }> {
    if (suspectTestId) {
      const fromTest = parseCampaignEmailContent(
        await this.smartDelivery.getEmailContent(suspectTestId).catch(() => null),
      );
      if (fromTest.body) return fromTest;
    }
    const sequences = await this.smartlead.getCampaignSequences(campaignId);
    const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
    if (!sequence) return {};
    const variant = sequence.sequence_variants?.[0] ?? sequence.variants?.[0];
    const body = variant?.email_body ?? sequence.email_body;
    return {
      subject: sequenceSubjectPreview(sequence),
      body: body ? stripHtml(body) : undefined,
    };
  }
}

function providerSplit(rows: Array<{ inbox_count?: number; spam_count?: number; inbox_rate?: number; spam_rate?: number; adjusted_total_email_count?: number; total_email_count?: number }>): {
  primary: number;
  spam: number;
  samples: number;
} {
  let inbox = 0;
  let spam = 0;
  let total = 0;
  for (const row of rows) {
    if (typeof row.inbox_count === "number") inbox += row.inbox_count;
    if (typeof row.spam_count === "number") spam += row.spam_count;
    const count = row.adjusted_total_email_count ?? row.total_email_count;
    if (typeof count === "number") total += count;
  }
  if (total > 0) {
    return { primary: (inbox / total) * 100, spam: (spam / total) * 100, samples: total };
  }
  const rates = rows.filter((row) => typeof row.inbox_rate === "number");
  if (!rates.length) return { primary: 0, spam: 0, samples: 0 };
  const primary =
    rates.reduce((sum, row) => sum + (row.inbox_rate ?? 0), 0) / rates.length;
  return { primary, spam: 100 - primary, samples: rates.length };
}
