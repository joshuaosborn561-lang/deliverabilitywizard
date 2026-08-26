import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  accountDomain,
  campaignIdsOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import type { InventoryBook } from "./inventory.js";
import type { SmartleadSequence } from "../types/index.js";
import { canDecideIsolationAction } from "../lib/isolationActors.js";
import { signatureCampaignIdsOf } from "../lib/isolationActions.js";
import { appendSignatureTag } from "../lib/signatureQa.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import { slackKindForIsolationAction } from "../lib/slackAllow.js";
import type { IsolationBuyService } from "./isolationBuy.js";
import type { CopyCanaryBuyService } from "./copyCanaryBuy.js";

export class IsolationExecuteService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly buy: IsolationBuyService,
    private readonly book: InventoryBook,
    private readonly canaryBuy?: CopyCanaryBuyService,
  ) {}

  async decide(
    actionId: string,
    decision: "approve" | "deny",
    actor: { name: string; role: "owner" | "operator" | "unknown" },
  ): Promise<{ ok: boolean; message: string }> {
    const action = this.state.getIsolationAction(actionId);
    if (!action) {
      return { ok: false, message: "That request is no longer waiting." };
    }
    if (action.status !== "pending") {
      if (
        action.kind === "buy_canary_fleet" &&
        (action.status === "approved" || action.status === "executed")
      ) {
        const domains = Array.isArray(action.detail.domains)
          ? (action.detail.domains as string[]).join(", ")
          : "";
        return {
          ok: true,
          message: domains
            ? `Already done — bought ${domains}. Mailboxes finish when nameservers catch up. No second tap.`
            : "Already done — that buy is in progress. No second tap.",
        };
      }
      return {
        ok: false,
        message: `This request is already ${action.status}.`,
      };
    }
    if (!canDecideIsolationAction(action.kind, actor.role)) {
      return {
        ok: false,
        message:
          action.kind === "swap_copy" || action.kind === "add_signature_tag"
            ? "Josh or Cayden can approve this copy edit."
            : "Only Josh can approve retiring a domain or buying replacements / the canary fleet.",
      };
    }
    if (decision === "deny") {
      this.state.upsertIsolationAction({
        ...action,
        status: "denied",
        decidedAt: new Date().toISOString(),
        decidedBy: actor.name,
      });
      await this.state.save();
      await this.announce(
        action.kind,
        `${action.title}\n${actor.name} said not now. I left everything as-is.`,
      );
      return { ok: true, message: "Okay — I left it alone." };
    }
    const approved: IsolationActionRecord = {
      ...action,
      status: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: actor.name,
    };
    this.state.upsertIsolationAction(approved);
    try {
      if (approved.kind === "retire_domain") await this.retire(approved);
      else if (approved.kind === "swap_copy") await this.swapCopy(approved);
      else if (approved.kind === "add_signature_tag")
        await this.addSignatureTag(approved);
      else if (approved.kind === "buy_canary_fleet")
        await this.buyCanaryFleet(approved);
      else if (approved.kind === "generic_backfill")
        await this.approveGenericBackfill(approved, actor.name);
      else await this.buyDomains(approved);
      this.state.upsertIsolationAction({
        ...this.state.getIsolationAction(actionId)!,
        status: "executed",
        executedAt: new Date().toISOString(),
      });
      await this.state.save();
      return { ok: true, message: "Done." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.upsertIsolationAction({
        ...this.state.getIsolationAction(actionId)!,
        status: "failed",
        error: message,
      });
      await this.state.save();
      await this.announce(
        action.kind,
        `${action.title}\nI tried after ${actor.name} approved and hit: ${message}`,
      );
      return { ok: false, message };
    }
  }

  private async retire(action: IsolationActionRecord): Promise<void> {
    const domain = String(action.detail.domain ?? "").toLowerCase();
    if (!domain) throw new Error("Missing domain");
    const { campaigns, accounts } = await this.book.get();
    const active = new Set(
      campaigns
        .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE")
        .map((campaign) => campaign.id),
    );
    const onDomain = accounts.filter(
      (account) => accountDomain(account) === domain,
    );
    let removed = 0;
    const cutCampaignIds = new Set<number>();
    for (const account of onDomain) {
      const ids = campaignIdsOf(account).filter((id) => active.has(id));
      if (!ids.length) continue;
      for (const campaignId of ids) {
        await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
          account.id,
        ]);
        removed += 1;
        cutCampaignIds.add(campaignId);
      }
    }
    const history = this.state.getDomainHistory(domain);
    if (history) {
      this.state.upsertDomainHistory({
        ...history,
        status: "retired",
        retiredAt: new Date().toISOString(),
      });
    }
    // D134 — the tap that cut senders is also the approval for generics to
    // cover those campaigns: sending volume must not drop while the
    // replacement domains warm. Approving is allowing, never forcing — the
    // half-floor and the generic rest clock still govern.
    let backfilled = 0;
    for (const campaignId of cutCampaignIds) {
      if (this.state.getGenericBackfillApproval(campaignId)) continue;
      this.state.approveGenericBackfill({
        campaignId,
        approvedAt: new Date().toISOString(),
        approvedBy: `retire:${domain}`,
      });
      backfilled += 1;
    }
    await this.announce(
      "retire_domain",
      [
        `Retired *${domain}*.`,
        `Pulled ${onDomain.length} inbox${onDomain.length === 1 ? "" : "es"} off live campaigns (${removed} membership${removed === 1 ? "" : "s"}).`,
        cutCampaignIds.size
          ? `Generics may cover the ${cutCampaignIds.size} campaign(s) that lost senders until the replacements finish their 21 days (D134)${backfilled < cutCampaignIds.size ? " — some already had approval" : ""}.`
          : undefined,
        "Health will fill those campaigns from clean spare inboxes on its own.",
        action.proof,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  private async buyDomains(action: IsolationActionRecord): Promise<void> {
    const result = await this.buy.run(action);
    await this.announce(
      "buy_domains",
      [
        `Bought ${result.domains.join(", ") || "the replacement domain"}.`,
        result.mailboxesOrdered
          ? `${result.mailboxesOrdered} mailbox${result.mailboxesOrdered === 1 ? "" : "es"} ordered. They owe 21 days of warmup before live send.`
          : undefined,
        result.awaitingNameservers
          ? "Nameservers are still catching up. I will finish the mailbox order myself — no second tap."
          : undefined,
        action.proof,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  private async buyCanaryFleet(action: IsolationActionRecord): Promise<void> {
    if (!this.canaryBuy) {
      throw new Error("Canary fleet buy is not wired.");
    }
    const result = await this.canaryBuy.run(action);
    await this.slack.send(
      [
        `Bought the unwarmed canary fleet: ${result.domains.join(", ") || "two new domains"}.`,
        `Google: ${result.googleDomain ?? "pending"}. Outlook: ${result.microsoftDomain ?? "pending"}.`,
        result.mailboxesOrdered
          ? `${result.mailboxesOrdered} mailbox${result.mailboxesOrdered === 1 ? "" : "es"} ordered. Warmup stays off. They send campaign copy in placement tests and stay off live campaigns.`
          : undefined,
        result.awaitingNameservers
          ? "Nameservers are still catching up. I will finish the mailbox order myself — no second tap."
          : undefined,
        result.awaitingExport
          ? "Inboxes are bought. I will import them into Smartlead and keep warmup off."
          : undefined,
        action.proof,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  /**
   * D133 — one tap fixes the word everywhere. The verdict was isolated on
   * one campaign, but a spam word is not that campaign's private problem:
   * the same tap deletes/replaces it across every ACTIVE campaign whose
   * live sequence carries it. Shells are paused and never ACTIVE. A re-tap
   * after a partial failure skips campaigns already clean.
   */
  private async swapCopy(action: IsolationActionRecord): Promise<void> {
    const find = String(action.detail.element ?? "");
    const swap = String(action.detail.swap ?? "");
    if (!find) throw new Error("Missing word");
    const { campaigns } = await this.book.get();
    const targets = campaigns.filter(
      (campaign) =>
        String(campaign.status ?? "").toUpperCase() === "ACTIVE" &&
        !isAnyShellCampaign(campaign),
    );
    const edited: string[] = [];
    const failed: string[] = [];
    for (const campaign of targets) {
      const label = String(campaign.name ?? `#${campaign.id}`);
      try {
        const sequences = await this.smartlead.getCampaignSequences(campaign.id);
        const carrying = (sequences ?? []).filter((sequence) =>
          sequenceContainsWord(sequence, find),
        );
        if (!carrying.length) continue;
        await this.smartlead.updateCampaignSequences(
          campaign.id,
          (sequences ?? []).map((sequence) =>
            carrying.includes(sequence)
              ? replaceInSequence(sequence, find, swap)
              : sequence,
          ),
        );
        edited.push(label);
        await sleep(WORD_SWAP_WRITE_GAP_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push(`${label}: ${message}`);
      }
    }
    await this.announce(
      "swap_copy",
      [
        `Switched the word fleet-wide: ${find} → ${swap || "(removed)"}.`,
        edited.length
          ? `Edited ${edited.length} ACTIVE campaign(s): ${edited.map((name) => `*${name}*`).join(", ")}.`
          : "No ACTIVE campaign still carried it.",
        "That word edit is the only change I made.",
      ].join("\n"),
    );
    if (failed.length) {
      throw new Error(
        `Could not edit ${failed.length} campaign(s): ${failed.join("; ")}. Tap again — campaigns already clean are skipped.`,
      );
    }
  }

  /**
   * D85/D87 — append `%signature%` to every step/variant body missing it,
   * for one campaign or a bulk-approved list. Append-only by construction
   * (appendSignatureTag); the rest of the copy is written back
   * byte-for-byte. A partial failure reports the successes and throws so
   * the action can be re-tapped — re-runs skip already-tagged bodies.
   */
  private async addSignatureTag(action: IsolationActionRecord): Promise<void> {
    const ids = signatureCampaignIdsOf(action);
    if (!ids.length) throw new Error("Missing campaign");
    const names = new Map<number, string>();
    if (typeof action.detail.campaignName === "string") {
      names.set(ids[0]!, action.detail.campaignName);
    }
    if (Array.isArray(action.detail.campaigns)) {
      for (const row of action.detail.campaigns as Array<{
        id?: unknown;
        name?: unknown;
      }>) {
        const id = Number(row.id);
        if (Number.isFinite(id) && typeof row.name === "string") {
          names.set(id, row.name);
        }
      }
    }

    const done: string[] = [];
    const failed: string[] = [];
    for (const campaignId of ids) {
      const label = names.get(campaignId) ?? `#${campaignId}`;
      try {
        const sequences = await this.smartlead.getCampaignSequences(campaignId);
        const { sequences: next, changed } = appendSignatureTag(sequences ?? []);
        if (!changed.length) {
          done.push(`*${label}* already had the tag everywhere`);
          continue;
        }
        await this.smartlead.updateCampaignSequences(campaignId, next);
        done.push(`*${label}*: ${changed.join(", ")}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push(`${label}: ${message}`);
      }
    }

    if (done.length) {
      await this.announce(
        "add_signature_tag",
        [
          `Added %signature% where it was missing — appended the tag only, no other copy changed:`,
          ...done.map((line) => `• ${line}`),
          "The next sweep unblocks these campaigns.",
        ].join("\n"),
      );
    }
    if (failed.length) {
      throw new Error(
        `Could not write ${failed.length} campaign(s): ${failed.join("; ")}. Tap again to retry — already-tagged steps are skipped.`,
      );
    }
  }

  private async approveGenericBackfill(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<void> {
    const campaignId = Number(action.detail.campaignId);
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      throw new Error("Missing campaign");
    }
    this.state.approveGenericBackfill({
      campaignId,
      approvedAt: new Date().toISOString(),
      approvedBy: actor,
    });
    await this.announce(
      "generic_backfill",
      `Generics may backfill *${action.detail.campaignName ?? campaignId}*. Floor stays half that client's inboxes.`,
    );
  }

  private async announce(
    kind: IsolationActionRecord["kind"],
    text: string,
  ): Promise<void> {
    if (!slackKindForIsolationAction(kind)) {
      console.log(
        `[slack-quiet] ${kind}: ${text.replace(/\n/g, " ").slice(0, 160)}`,
      );
      return;
    }
    await this.slack.send(text, undefined, "action_result");
  }
}

/** D133 — pause between fleet-wide sequence writes so Smartlead breathes. */
const WORD_SWAP_WRITE_GAP_MS = 1000;

/** D133 — does any step, subject or variant of this sequence carry the word? */
export function sequenceContainsWord(
  sequence: SmartleadSequence,
  find: string,
): boolean {
  const pattern = new RegExp(escapeRegExp(find), "i");
  const texts: Array<string | undefined> = [
    sequence.subject,
    sequence.email_body,
    ...(sequence.sequence_variants ?? []).flatMap((variant) => [
      variant.subject,
      variant.email_body,
    ]),
    ...(sequence.seq_variants ?? []).flatMap((variant) => [
      variant.subject,
      variant.email_body,
    ]),
    ...(sequence.variants ?? []).flatMap((variant) => [
      variant.subject,
      variant.email_body,
    ]),
  ];
  return texts.some((value) => Boolean(value && pattern.test(value)));
}

export function replaceInSequence(
  sequence: SmartleadSequence,
  find: string,
  swap: string,
): SmartleadSequence {
  const replace = (value?: string) =>
    value ? value.replace(new RegExp(escapeRegExp(find), "ig"), swap) : value;
  return {
    ...sequence,
    subject: replace(sequence.subject),
    email_body: replace(sequence.email_body),
    sequence_variants: sequence.sequence_variants?.map((variant) => ({
      ...variant,
      subject: replace(variant.subject),
      email_body: replace(variant.email_body),
    })),
    seq_variants: sequence.seq_variants?.map((variant) => ({
      ...variant,
      subject: replace(variant.subject),
      email_body: replace(variant.email_body),
    })),
    variants: sequence.variants?.map((variant) => ({
      ...variant,
      subject: replace(variant.subject),
      email_body: replace(variant.email_body),
    })),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
