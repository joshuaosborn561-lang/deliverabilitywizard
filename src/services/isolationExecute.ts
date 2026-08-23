import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  accountDomain,
  campaignIdsOf,
  pickSequence,
  type SmartleadClient,
} from "../clients/smartlead.js";
import type { SmartleadSequence } from "../types/index.js";
import { canDecideIsolationAction } from "../lib/isolationActors.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import type { IsolationBuyService } from "./isolationBuy.js";
import type { CopyCanaryBuyService } from "./copyCanaryBuy.js";

export class IsolationExecuteService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly buy: IsolationBuyService,
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
          action.kind === "swap_copy"
            ? "Josh or Cayden can switch the word."
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
      await this.slack.send(
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
      else if (approved.kind === "buy_canary_fleet")
        await this.buyCanaryFleet(approved);
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
      await this.slack.send(
        `${action.title}\nI tried after ${actor.name} approved and hit: ${message}`,
      );
      return { ok: false, message };
    }
  }

  private async retire(action: IsolationActionRecord): Promise<void> {
    const domain = String(action.detail.domain ?? "").toLowerCase();
    if (!domain) throw new Error("Missing domain");
    const [campaigns, accounts] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
    ]);
    const active = new Set(
      campaigns
        .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE")
        .map((campaign) => campaign.id),
    );
    const onDomain = accounts.filter(
      (account) => accountDomain(account) === domain,
    );
    let removed = 0;
    for (const account of onDomain) {
      const ids = campaignIdsOf(account).filter((id) => active.has(id));
      if (!ids.length) continue;
      for (const campaignId of ids) {
        await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
          account.id,
        ]);
        removed += 1;
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
    await this.slack.send(
      [
        `Retired *${domain}*.`,
        `Pulled ${onDomain.length} inbox${onDomain.length === 1 ? "" : "es"} off live campaigns (${removed} membership${removed === 1 ? "" : "s"}).`,
        "Health will fill those campaigns from clean spare inboxes on its own.",
        action.proof,
      ].join("\n"),
    );
  }

  private async buyDomains(action: IsolationActionRecord): Promise<void> {
    const result = await this.buy.run(action);
    await this.slack.send(
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

  private async swapCopy(action: IsolationActionRecord): Promise<void> {
    const campaignId = Number(action.detail.campaignId);
    const find = String(action.detail.element ?? "");
    const swap = String(action.detail.swap ?? "");
    if (!campaignId || !find) throw new Error("Missing campaign or word");
    const sequences = await this.smartlead.getCampaignSequences(campaignId);
    const current = pickSequence(sequences ?? [], this.config.sequenceNumber);
    if (!current) throw new Error("No sequence to edit");
    const next = replaceInSequence(current, find, swap);
    await this.smartlead.updateCampaignSequences(
      campaignId,
      sequences.map((sequence) =>
        sequence.id === current.id ? next : sequence,
      ),
    );
    await this.slack.send(
      `Switched the word on *${action.detail.campaignName ?? campaignId}*: ${find} → ${swap || "(removed)"}. That is the only change I made.`,
    );
  }
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
