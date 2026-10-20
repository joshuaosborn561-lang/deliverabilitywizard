import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  accountDomain,
  campaignIdsOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  callerFollowUpAlertKey,
  callerFollowUpHumanActionAlert,
  callerFollowUpMustPageBeforeAct,
  callerFollowUpPolicyFromConfig,
} from "../lib/callerFollowUp.js";
import { sleep } from "../lib/http.js";
import type { InventoryBook } from "./inventory.js";
import type { SmartleadSequence } from "../types/index.js";
import { canDecideIsolationAction } from "../lib/isolationActors.js";
import {
  buildIsolationAction,
  persistRetiredDomainHistory,
  retireAlreadySettled,
  signatureCampaignIdsOf,
} from "../lib/isolationActions.js";
import { appendSignatureTag } from "../lib/signatureQa.js";
import {
  espMixFromAccountTypes,
  platformsMatchingEspMix,
} from "../lib/retireEspMix.js";
import {
  AWAITING_PURCHASE,
  purchasedDomainsOf,
} from "../lib/buyResume.js";
import {
  ownerFromActionDetail,
  ownerOfDomain,
  ownerOnActionDetail,
  refreshDomainOwnerCache,
} from "../lib/retireAsk.js";
import { replacementParentForRetiredDomain } from "../lib/retireReplacement.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import { recordIsolationUnlinkAttachBlock } from "../lib/attachBlock.js";
import { slackKindForIsolationAction } from "../lib/slackAllow.js";
import { clearAskCopies } from "../lib/slackAskResolve.js";
import type { IsolationBuyService } from "./isolationBuy.js";
import type { CopyCanaryBuyService } from "./copyCanaryBuy.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import { mailboxDomainOf } from "../clients/inboxkit.js";
import { mailboxOrderFollowup } from "../lib/inboxkitWorkspace.js";
import {
  markSpendDoneForAsk,
  pruneSatisfiedPendingSpend,
} from "../lib/pendingSpendPrune.js";
import {
  isTransientTapError,
  withTransientRetry,
} from "../lib/transientRetry.js";
import { doneByLine } from "../lib/slackAskResolve.js";

export class IsolationExecuteService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly buy: IsolationBuyService,
    private readonly book: InventoryBook,
    private readonly canaryBuy?: CopyCanaryBuyService,
    private readonly inboxkit?: InboxKitClient | null,
  ) {}

  /**
   * D294 — write approved on every id (sidecar) before any purchase.
   * Josh-only kinds stay pending when the tapper is not Josh.
   */
  async stampApprovals(
    ids: string[],
    actor: { name: string; role: "owner" | "operator" | "unknown" },
  ): Promise<string[]> {
    const now = new Date().toISOString();
    const stamped: string[] = [];
    for (const id of ids) {
      const action = this.state.getIsolationAction(id);
      if (!action || action.status !== "pending") continue;
      if (!canDecideIsolationAction(action.kind, actor.role)) continue;
      this.state.upsertIsolationAction({
        ...action,
        status: "approved",
        decidedAt: now,
        decidedBy: actor.name,
      });
      stamped.push(id);
    }
    if (stamped.length) await this.state.persistIsolationDecisions();
    return stamped;
  }

  /** D294 — finish approved retires / buys that died before executedAt. */
  async resumeDecided(): Promise<number> {
    let n = 0;
    for (const action of this.state.listIsolationActions()) {
      if (!this.shouldResumeApproved(action, "approve")) continue;
      const name = action.decidedBy?.trim() || "the wizard";
      const result = await this.decide(action.id, "approve", {
        name,
        role: "owner",
      });
      if (result.ok) n += 1;
    }
    return n;
  }

  private shouldResumeApproved(
    action: IsolationActionRecord,
    decision: "approve" | "deny",
  ): boolean {
    if (decision !== "approve") return false;
    if (action.status !== "approved") return false;
    if (action.executedAt) return false;
    if (this.inFlight.has(action.id)) return false;
    if (action.kind === "retire_domain") return true;
    if (
      (action.kind === "buy_domains" || action.kind === "buy_isolation_domain") &&
      purchasedDomainsOf(action).length === 0
    ) {
      return true;
    }
    return false;
  }

  async decide(
    actionId: string,
    decision: "approve" | "deny",
    actor: { name: string; role: "owner" | "operator" | "unknown" },
  ): Promise<{ ok: boolean; message: string }> {
    const action = this.state.getIsolationAction(actionId);
    if (!action) {
      return { ok: false, message: "That request is no longer waiting." };
    }
    if (this.inFlight.has(actionId)) {
      return {
        ok: true,
        message: doneByLine(
          actor.name,
          "Already working on that tap. No second purchase.",
        ),
      };
    }
    if (this.shouldResumeApproved(action, decision)) {
      const approved: IsolationActionRecord = {
        ...action,
        status: "approved",
        decidedAt: action.decidedAt ?? new Date().toISOString(),
        decidedBy: action.decidedBy || actor.name,
      };
      this.state.upsertIsolationAction(approved);
      await this.state.persistIsolationDecision(approved);
      this.inFlight.add(actionId);
      try {
        const summary = await withTransientRetry(
          () => this.runApproved(approved, actor.name),
          process.env.NODE_TEST_CONTEXT
            ? { backoffMs: [0, 0, 0], sleepFn: async () => undefined }
            : {},
        );
        this.state.upsertIsolationAction({
          ...this.state.getIsolationAction(actionId)!,
          status: "executed",
          executedAt: new Date().toISOString(),
          error: undefined,
        });
        markSpendDoneForAsk(this.state, {
          actionId,
          domain: String(
            approved.detail.domain ?? approved.detail.retiredDomain ?? "",
          ),
          decidedBy: actor.name,
        });
        pruneSatisfiedPendingSpend(this.state);
        await this.state.save();
        await this.clearCopies(
          this.state.getIsolationAction(actionId)!,
          actor.name,
        );
        return { ok: true, message: doneByLine(actor.name, summary) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.state.getIsolationAction(actionId)!;
        this.state.upsertIsolationAction({
          ...current,
          status: "approved",
          error: message,
        });
        await this.state.persistIsolationDecision(
          this.state.getIsolationAction(actionId)!,
        );
        return { ok: false, message: doneByLine(actor.name, message) };
      } finally {
        this.inFlight.delete(actionId);
      }
    }
    if (action.status !== "pending") {
      await this.clearCopies(action, actor.name);
      pruneSatisfiedPendingSpend(this.state);
      markSpendDoneForAsk(this.state, {
        actionId,
        domain: String(action.detail.domain ?? action.detail.retiredDomain ?? ""),
        decidedBy: actor.name,
      });
      if (
        (action.kind === "buy_canary_fleet" ||
          action.kind === "buy_domains" ||
          action.kind === "buy_isolation_domain") &&
        (action.status === "approved" || action.status === "executed")
      ) {
        const domains = Array.isArray(action.detail.domains)
          ? (action.detail.domains as string[]).join(", ")
          : "";
        return {
          ok: true,
          message: doneByLine(
            actor.name,
            domains
              ? `Already done — bought ${domains}. No second tap.`
              : "Already done — that buy is in progress. No second tap.",
          ),
        };
      }
      if (
        action.kind === "retire_domain" &&
        (action.status === "approved" || action.status === "executed")
      ) {
        const domain = String(action.detail.domain ?? "").toLowerCase();
        return {
          ok: true,
          message: doneByLine(
            actor.name,
            domain
              ? `Already retired — ${domain} stays off. No second purchase.`
              : "Already retired — no second purchase.",
          ),
        };
      }
      return {
        ok: false,
        message: doneByLine(
          actor.name,
          `This request is already ${action.status}.`,
        ),
      };
    }
    if (!canDecideIsolationAction(action.kind, actor.role)) {
      return {
        ok: false,
        message:
          action.kind === "swap_copy" || action.kind === "add_signature_tag"
            ? "Josh or Cayden can approve this copy edit."
            : action.kind === "retire_domain" || action.kind === "buy_domains"
              ? "Cayden or Josh can approve this retire or replacement buy."
              : "Only Josh can approve buying the canary fleet, the isolation domain, or generic backfill.",
      };
    }
    const retireHost = String(action.detail.domain ?? "").toLowerCase();
    if (
      decision === "approve" &&
      action.kind === "retire_domain" &&
      retireHost &&
      retireAlreadySettled(this.state, retireHost)
    ) {
      this.state.upsertIsolationAction({
        ...action,
        status: "executed",
        decidedAt: new Date().toISOString(),
        decidedBy: actor.name,
        executedAt: new Date().toISOString(),
        error:
          "Already retired (D179). Confirm was a no-op — no second purchase.",
      });
      persistRetiredDomainHistory(this.state, retireHost);
      await this.state.save();
      await this.clearCopies(
        this.state.getIsolationAction(actionId) ?? action,
        actor.name,
      );
      pruneSatisfiedPendingSpend(this.state);
      return {
        ok: true,
        message: doneByLine(
          actor.name,
          `Already retired — ${retireHost} stays off. No second purchase.`,
        ),
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
      await this.clearCopies(
        this.state.getIsolationAction(actionId) ?? action,
        actor.name,
      );
      await this.announce(
        action.kind,
        doneByLine(actor.name, `${action.title} — not now. I left everything as-is.`),
      );
      return {
        ok: true,
        message: doneByLine(actor.name, "Okay — I left it alone."),
      };
    }
    const approved: IsolationActionRecord = {
      ...action,
      status: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: actor.name,
    };
    this.state.upsertIsolationAction(approved);
    await this.state.persistIsolationDecision(approved);
    this.inFlight.add(actionId);
    try {
      const summary = await withTransientRetry(
        () => this.runApproved(approved, actor.name),
        process.env.NODE_TEST_CONTEXT
          ? { backoffMs: [0, 0, 0], sleepFn: async () => undefined }
          : {},
      );
      this.state.upsertIsolationAction({
        ...this.state.getIsolationAction(actionId)!,
        status: "executed",
        executedAt: new Date().toISOString(),
        error: undefined,
      });
      markSpendDoneForAsk(this.state, {
        actionId,
        domain: String(
          approved.detail.domain ?? approved.detail.retiredDomain ?? "",
        ),
        decidedBy: actor.name,
      });
      pruneSatisfiedPendingSpend(this.state);
      await this.state.save();
      await this.clearCopies(
        this.state.getIsolationAction(actionId)!,
        actor.name,
      );
      return { ok: true, message: doneByLine(actor.name, summary) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.state.getIsolationAction(actionId)!;
      const pulled =
        current.kind === "retire_domain" &&
        (retireAlreadySettled(this.state, String(current.detail.domain ?? "")) ||
          this.state.getDomainHistory(String(current.detail.domain ?? ""))
            ?.status === "retired");
      const retryableBuy =
        (current.kind === "buy_domains" ||
          current.kind === "buy_isolation_domain") &&
        purchasedDomainsOf(current).length === 0;
      const stayPending =
        isTransientTapError(error) &&
        !pulled &&
        purchasedDomainsOf(current).length === 0;
      this.state.upsertIsolationAction({
        ...current,
        status: stayPending
          ? "pending"
          : retryableBuy
            ? "approved"
            : "failed",
        error: message,
        decidedBy: stayPending ? undefined : current.decidedBy,
        decidedAt: stayPending ? undefined : current.decidedAt,
        detail: stayPending
          ? { ...current.detail, lastTapError: message }
          : retryableBuy
            ? {
                ...current.detail,
                phase: AWAITING_PURCHASE,
                retryReason: message,
              }
            : current.detail,
      });
      await this.state.save();
      await this.announce(
        action.kind,
        doneByLine(
          actor.name,
          `${action.title} — I tried and hit: ${message}`,
        ),
      );
      return { ok: false, message: doneByLine(actor.name, message) };
    } finally {
      this.inFlight.delete(actionId);
    }
  }

  private async runApproved(
    approved: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
    if (approved.kind === "retire_domain") return this.retire(approved, actor);
    if (approved.kind === "swap_copy") return this.swapCopy(approved, actor);
    if (approved.kind === "add_signature_tag") {
      return this.addSignatureTag(approved, actor);
    }
    if (approved.kind === "buy_canary_fleet") {
      return this.buyCanaryFleet(approved, actor);
    }
    if (approved.kind === "buy_isolation_domain") {
      return this.buyIsolationDomain(approved, actor);
    }
    if (approved.kind === "generic_backfill") {
      return `${actor} — Allow-generics is retired (D268). Generics top up to the floor only; I did not Allow and I did not attach.`;
    }
    return this.buyDomains(approved, actor);
  }

  private async retire(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
    const domain = String(action.detail.domain ?? "").toLowerCase();
    if (!domain) throw new Error("Missing domain");
    const { campaigns, accounts, clients } = await this.book.get();
    refreshDomainOwnerCache(this.state, accounts, clients, this.config);
    const owner =
      ownerOfDomain(domain, this.state, accounts, clients, this.config) ??
      ownerFromActionDetail(action.detail);
    const active = new Set(
      campaigns
        .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE")
        .map((campaign) => campaign.id),
    );
    if (retireAlreadySettled(this.state, domain)) {
      persistRetiredDomainHistory(this.state, domain);
      recordIsolationUnlinkAttachBlock(this.state, {
        domain,
        emails: [],
        accountIds: [],
        reason: "burned",
        source: `retire:${domain}:already`,
      });
      const already = [
        `Already retired *${domain}*.`,
        "No inboxes were pulled and no replacement was bought (D179).",
        action.proof,
      ].join("\n");
      await this.announce("retire_domain", doneByLine(actor, already));
      return already;
    }
    const onDomain = accounts.filter(
      (account) => accountDomain(account) === domain,
    );
    let removed = 0;
    const cutCampaignIds = new Set<number>();
    for (const account of onDomain) {
      const ids = campaignIdsOf(account).filter((id) => active.has(id));
      if (!ids.length) continue;
      if (
        callerFollowUpMustPageBeforeAct({
          action: "unlink",
          account,
          policy: callerFollowUpPolicyFromConfig(this.config),
        })
      ) {
        const email = accountEmail(account) ?? "";
        const key = callerFollowUpAlertKey({
          action: "unlink",
          email,
          campaignId: ids[0],
        });
        if (!this.state.hasAlert(key)) {
          await this.slack.send(
            callerFollowUpHumanActionAlert({
              action: "unlink",
              email,
              campaignId: ids[0],
              reason: `retire of ${domain} — automation will not pull this seat`,
            }),
            undefined,
            "ops_alert",
          );
          this.state.markAlert(key);
        }
        continue;
      }
      for (const campaignId of ids) {
        // D207 — RETIRE / burned-domain pull is exempt from the 40 floor.
        await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
          account.id,
        ]);
        removed += 1;
        cutCampaignIds.add(campaignId);
      }
    }
    recordIsolationUnlinkAttachBlock(this.state, {
      domain,
      emails: onDomain
        .map((account) => accountEmail(account))
        .filter((email): email is string => Boolean(email)),
      accountIds: onDomain.map((account) => account.id),
      reason: "burned",
      source: `retire:${domain}`,
    });
    persistRetiredDomainHistory(this.state, domain);

    // D150 — same tap also buys the replacement domain with ESP-matched
    // mailboxes. Josh's retire approve is the spend approval; do not open a
    // second buy ask. Failures after the pull still leave D134 backfill on.
    const espMix = espMixFromAccountTypes(onDomain.map((account) => account.type));
    const platforms = platformsMatchingEspMix(
      espMix,
      this.config.isolationMailboxesPerBuyDomain,
    );
    let buySummary: string | undefined;
    const buyAction = buildIsolationAction({
      kind: "buy_domains",
      title: `Replacement for retired ${domain}`,
      proof: action.proof,
      detail: {
        domain,
        quantity: 1,
        parentDomain: replacementParentForRetiredDomain(
          domain,
          this.config,
          { kind: "buy_domains", owner },
        ),
        espMix,
        platforms,
        retiredDomain: domain,
        phase: AWAITING_PURCHASE,
        ...ownerOnActionDetail(owner),
      },
    });
    buyAction.status = "approved";
    buyAction.decidedAt = new Date().toISOString();
    buyAction.decidedBy = action.decidedBy || actor;
    this.state.upsertIsolationAction(buyAction);
    try {
      const result = await this.buy.run(buyAction);
      this.state.upsertIsolationAction({
        ...this.state.getIsolationAction(buyAction.id)!,
        status: "executed",
        executedAt: new Date().toISOString(),
        detail: {
          ...buyAction.detail,
          domains: result.domains,
          phase: result.awaitingNameservers ? "awaiting_mailboxes" : "complete",
          ...(result.espSkipReason
            ? { espSkipReason: result.espSkipReason }
            : {}),
        },
      });
      buySummary = [
        `Bought replacement ${result.domains.join(", ") || "domain"} with ${platforms.join("/") || "mixed"} mailboxes to match the retired mix (G${espMix.GOOGLE}/M${espMix.MICROSOFT}).`,
        result.mailboxesOrdered
          ? `${result.mailboxesOrdered} mailbox${result.mailboxesOrdered === 1 ? "" : "es"} ordered — they owe 21 days before live send.`
          : undefined,
        mailboxOrderFollowup(result),
        result.espSkipReason
          ? `InboxKit is one ESP per domain — ${result.espSkipReason}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.state.getIsolationAction(buyAction.id);
      if (current) {
        this.state.upsertIsolationAction({
          ...current,
          status: "approved",
          error: message,
          detail: {
            ...current.detail,
            phase: AWAITING_PURCHASE,
            retryReason: message,
          },
        });
      }
      buySummary = `Replacement buy failed after the pull: ${message}. I will retry the purchase myself — no second tap (D174).`;
    }

    const cancelNote = await this.scheduleRetiredInboxkitSeats(
      domain,
      onDomain
        .map((account) => accountEmail(account))
        .filter((email): email is string => Boolean(email)),
    );
    const summary = [
      `${actor} approved — retired *${domain}*.`,
      `Pulled ${onDomain.length} inbox${onDomain.length === 1 ? "" : "es"} off live campaigns (${removed} membership${removed === 1 ? "" : "s"}).`,
      cutCampaignIds.size
        ? `Health will thin-top those ${cutCampaignIds.size} campaign(s) to the floor from the generic pool (D268) until the replacements finish their 21 days.`
        : undefined,
      buySummary,
      cancelNote,
      "Health will fill those campaigns from clean spare inboxes on its own.",
      action.proof,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await this.announce("retire_domain", summary);
    return summary;
  }

  private async buyDomains(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
    const result = await this.buy.run(action);
    const summary = [
      `${actor} approved — bought ${result.domains.join(", ") || "the replacement domain"}.`,
      result.mailboxesOrdered
        ? `${result.mailboxesOrdered} mailbox${result.mailboxesOrdered === 1 ? "" : "es"} ordered. They owe 21 days of warmup before live send.`
        : undefined,
      mailboxOrderFollowup(result),
      action.proof,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await this.announce("buy_domains", summary);
    return summary;
  }

  /**
   * D137 — buy the word-hunt rig's isolation domain through the same
   * spend-gated pipeline as a replacement buy, then stamp it into state so
   * the rig arms itself (ISOLATION_DOMAIN in Railway still overrides).
   */
  private async buyIsolationDomain(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
    const result = await this.buy.run(action);
    const domain = result.domains[0]?.toLowerCase();
    if (domain) {
      const existing = this.state.getIsolation().isolationDomain;
      this.state.patchIsolation({
        isolationDomain: {
          mailboxIds: [],
          emails: [],
          status: "configured",
          ...(existing ?? {}),
          domain,
        },
      });
    }
    const summary = [
      domain
        ? `${actor} approved — bought *${domain}* as the word-hunt isolation domain.`
        : `${actor} approved — isolation-domain buy ran.`,
      result.mailboxesOrdered
        ? `${result.mailboxesOrdered} mailbox(es) ordered — the rig arms itself once they land in Smartlead.`
        : undefined,
      mailboxOrderFollowup(result),
      action.proof,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await this.announce("buy_isolation_domain", summary);
    return summary;
  }

  private async buyCanaryFleet(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
    if (!this.canaryBuy) {
      throw new Error("Canary fleet buy is not wired.");
    }
    const result = await this.canaryBuy.run(action);
    const summary = [
      `${actor} approved — bought the unwarmed canary fleet: ${result.domains.join(", ") || "two new domains"}.`,
      `Google: ${result.googleDomain ?? "pending"}. Outlook: ${result.microsoftDomain ?? "pending"}.`,
      result.mailboxesOrdered
        ? `${result.mailboxesOrdered} mailbox${result.mailboxesOrdered === 1 ? "" : "es"} ordered. Warmup stays off. They send campaign copy in placement tests and stay off live campaigns.`
        : undefined,
      mailboxOrderFollowup(result),
      result.awaitingExport
        ? "Inboxes are bought. I will import them into Smartlead and keep warmup off."
        : undefined,
      action.proof,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await this.slack.send(summary);
    return summary;
  }

  /**
   * D133 — one tap fixes the word everywhere. The verdict was isolated on
   * one campaign, but a spam word is not that campaign's private problem:
   * the same tap deletes/replaces it across every ACTIVE campaign whose
   * live sequence carries it. Shells are paused and never ACTIVE. A re-tap
   * after a partial failure skips campaigns already clean.
   */
  private async swapCopy(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
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
    const summary = [
      `${actor} approved — switched the word fleet-wide: ${find} → ${swap || "(removed)"}.`,
      edited.length
        ? `Edited ${edited.length} ACTIVE campaign(s): ${edited.map((name) => `*${name}*`).join(", ")}.`
        : "No ACTIVE campaign still carried it.",
      "That word edit is the only change I made.",
    ].join("\n");
    await this.announce("swap_copy", summary);
    if (failed.length) {
      throw new Error(
        `Could not edit ${failed.length} campaign(s): ${failed.join("; ")}. Tap again — campaigns already clean are skipped.`,
      );
    }
    return summary;
  }

  /**
   * D85/D87 — append `%signature%` to every step/variant body missing it,
   * for one campaign or a bulk-approved list. Append-only by construction
   * (appendSignatureTag); the rest of the copy is written back
   * byte-for-byte. A partial failure reports the successes and throws so
   * the action can be re-tapped — re-runs skip already-tagged bodies.
   */
  private async addSignatureTag(
    action: IsolationActionRecord,
    actor: string,
  ): Promise<string> {
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

    const summary = done.length
      ? [
          `${actor} approved — added %signature% where it was missing — appended the tag only, no other copy changed:`,
          ...done.map((line) => `• ${line}`),
          "The next sweep unblocks these campaigns.",
        ].join("\n")
      : `${actor} approved — every listed campaign already had the tag.`;
    if (done.length) {
      await this.announce("add_signature_tag", summary);
    }
    if (failed.length) {
      throw new Error(
        `Could not write ${failed.length} campaign(s): ${failed.join("; ")}. Tap again to retry — already-tagged steps are skipped.`,
      );
    }
    return summary;
  }

  /**
   * D266 — after a retire unlink, schedule those InboxKit seats for
   * cancellation. On failure, queue the list on the action for Onboarding.
   */
  private async scheduleRetiredInboxkitSeats(
    domain: string,
    emails: string[],
  ): Promise<string | undefined> {
    const host = domain.toLowerCase();
    const action = this.state
      .listIsolationActions()
      .find(
        (row) =>
          row.kind === "retire_domain" &&
          String(row.detail.domain ?? "").toLowerCase() === host,
      );
    const stamp = (detail: Record<string, unknown>) => {
      if (!action) return;
      this.state.upsertIsolationAction({
        ...action,
        detail: { ...action.detail, ...detail },
      });
    };
    if (!this.inboxkit) {
      stamp({
        retireSeatCancel: {
          status: "queued_onboarding",
          emails,
          error: "InboxKit is not configured",
          at: new Date().toISOString(),
        },
      });
      return "InboxKit seats were queued for Onboarding to cancel (InboxKit not configured).";
    }
    try {
      const found = await this.inboxkit.findDomainAnywhere(host);
      if (!found) {
        stamp({
          retireSeatCancel: {
            status: "queued_onboarding",
            emails,
            error: "domain not in InboxKit",
            at: new Date().toISOString(),
          },
        });
        return "InboxKit seats were queued for Onboarding — domain not found in InboxKit.";
      }
      const rows = await this.inboxkit.listMailboxes({
        domain: host,
        keyword: host,
        workspaceId: found.workspaceId,
        limit: 200,
      });
      const uids = rows
        .filter((row) => mailboxDomainOf(row) === host)
        .map((row) => row.uid || row.id)
        .filter((id): id is string => Boolean(id));
      if (uids.length) {
        await this.inboxkit.cancelMailboxes(uids, {
          workspaceId: found.workspaceId,
        });
      }
      const now = new Date().toISOString();
      for (const email of emails) {
        this.state.upsertInboxkitSeatEnd(email, {
          status: "scheduled_for_cancellation",
          cancelDate: now,
        });
      }
      stamp({
        retireSeatCancel: {
          status: "scheduled",
          emails,
          workspaceId: found.workspaceId,
          at: now,
        },
      });
      return `Scheduled ${uids.length || emails.length} InboxKit seat${
        (uids.length || emails.length) === 1 ? "" : "s"
      } on ${host} for cancellation.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stamp({
        retireSeatCancel: {
          status: "queued_onboarding",
          emails,
          error: message,
          at: new Date().toISOString(),
        },
      });
      return `Could not schedule InboxKit cancel (${message}). Queued for Onboarding.`;
    }
  }

  private async clearCopies(
    action: IsolationActionRecord | undefined,
    resolvedBy: string,
  ): Promise<void> {
    if (!action) return;
    const token =
      typeof this.slack.postingBotToken === "function"
        ? this.slack.postingBotToken()
        : "";
    if (!token) return;
    try {
      await clearAskCopies({
        detail: action.detail,
        botToken: token,
        resolvedBy,
      });
    } catch (error) {
      console.warn("[isolation] clear ask copies failed", error);
    }
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
