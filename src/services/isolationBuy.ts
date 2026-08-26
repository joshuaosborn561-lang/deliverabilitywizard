import { InboxKitClient } from "../clients/inboxkit.js";
import { PorkbunClient } from "../clients/porkbun.js";
import type { AppConfig } from "../config.js";
import { generateDomainSpins } from "../lib/domainNaming.js";
import { pickUniquePersonNames } from "../lib/personNames.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export interface IsolationBuyResult {
  domains: string[];
  mailboxesOrdered: number;
  awaitingNameservers: boolean;
}

export class IsolationBuyService {
  constructor(
    private readonly config: AppConfig,
    private readonly inboxkit: InboxKitClient | null,
    private readonly porkbun: PorkbunClient | null,
    private readonly store: StateStore,
    private readonly spend: SpendGateway,
  ) {}

  async run(action: IsolationActionRecord): Promise<IsolationBuyResult> {
    const quantity = Math.max(1, Number(action.detail.quantity ?? 1));
    const decidedBy = action.decidedBy ?? "Josh";
    const domains =
      Array.isArray(action.detail.domains) && action.detail.domains.length
        ? (action.detail.domains as string[])
        : await this.purchaseDomains(quantity, decidedBy, action);

    const mailboxes = await this.orderMailboxes(domains, decidedBy, action);
    this.store.upsertIsolationAction({
      ...this.store.getIsolationAction(action.id)!,
      detail: {
        ...action.detail,
        domains,
        phase: mailboxes.awaitingNameservers
          ? "awaiting_mailboxes"
          : "complete",
      },
    });
    return {
      domains,
      mailboxesOrdered: mailboxes.ordered,
      awaitingNameservers: mailboxes.awaitingNameservers,
    };
  }

  async resume(): Promise<number> {
    let finished = 0;
    for (const action of this.store.listIsolationActions()) {
      if (
        action.kind !== "buy_domains" &&
        action.kind !== "buy_isolation_domain"
      ) {
        continue;
      }
      if (action.status !== "executed" && action.status !== "approved") continue;
      if (action.detail.phase !== "awaiting_mailboxes") continue;
      const domains = Array.isArray(action.detail.domains)
        ? (action.detail.domains as string[])
        : [];
      if (!domains.length) continue;
      const mailboxes = await this.orderMailboxes(
        domains,
        action.decidedBy ?? "Josh",
        action,
      );
      if (!mailboxes.awaitingNameservers) {
        this.store.upsertIsolationAction({
          ...action,
          detail: { ...action.detail, phase: "complete" },
          status: "executed",
          executedAt: new Date().toISOString(),
        });
        finished += 1;
      }
    }
    if (finished) await this.store.save();
    return finished;
  }

  private async purchaseDomains(
    quantity: number,
    decidedBy: string,
    action: IsolationActionRecord,
  ): Promise<string[]> {
    if (!this.porkbun) {
      throw new Error("Porkbun keys are not set, so I cannot buy a domain.");
    }
    if (!this.inboxkit) {
      throw new Error("InboxKit is not configured, so I cannot attach nameservers.");
    }
    const parent =
      String(action.detail.parentDomain ?? "") ||
      this.config.isolationBuyParentDomain;
    const owned = new Set(
      this.store
        .listPoolMailboxes()
        .map((row) => row.domain.toLowerCase())
        .filter(Boolean),
    );
    const candidates = generateDomainSpins(parent).filter(
      (spin) => !owned.has(spin.domain),
    );
    const bought: string[] = [];
    for (const spin of candidates) {
      if (bought.length >= quantity) break;
      const check = await this.porkbun.checkDomainThrottled(spin.domain);
      if (!check.available) continue;
      const cents = PorkbunClient.priceToCents(check.price);
      if (cents == null) {
        throw new Error(`Porkbun did not quote a price for ${spin.domain}`);
      }
      const spendReq = {
        key: `porkbun:isolation:${spin.domain}`,
        scope: "generic_pool" as const,
        kind: "porkbun_domain",
        description: `Replacement sending domain ${spin.domain} after a known-good inbox test fail.`,
        detail: { domain: spin.domain, actionId: action.id },
      };
      if (this.config.dryRun) {
        bought.push(spin.domain);
        continue;
      }
      const decision = await this.spend.recordOwnerApproved(spendReq, decidedBy);
      await this.porkbun.createDomain(spin.domain, { costCents: cents });
      await this.spend.consume(decision, spendReq);
      const connected = await this.inboxkit.connectNameservers([spin.domain]);
      const nameservers = connected[0]?.nameservers ?? [];
      if (nameservers.length) {
        await this.porkbun.updateNameservers(spin.domain, nameservers);
      }
      bought.push(spin.domain);
    }
    if (bought.length < quantity) {
      throw new Error(
        `Only found ${bought.length} available replacement domain${bought.length === 1 ? "" : "s"} (needed ${quantity}).`,
      );
    }
    return bought;
  }

  private async orderMailboxes(
    domains: string[],
    decidedBy: string,
    action: IsolationActionRecord,
  ): Promise<{ ordered: number; awaitingNameservers: boolean }> {
    if (!this.inboxkit) {
      throw new Error("InboxKit is not configured, so I cannot buy mailboxes.");
    }
    const workspaceId =
      this.config.genericPoolWorkspaceId || this.config.inboxkitWorkspaceId;
    const perDomain = this.config.isolationMailboxesPerBuyDomain;
    if (this.config.dryRun) {
      return { ordered: domains.length * perDomain, awaitingNameservers: false };
    }

    const listed = await this.inboxkit.listDomains(workspaceId || undefined, {
      limit: 200,
    });
    const ready = new Set(
      listed
        .filter((row) => InboxKitClient.nameserversReady(row))
        .map((row) => (row.name || row.domain || "").toLowerCase()),
    );
    const pending = domains.filter((domain) => !ready.has(domain.toLowerCase()));
    if (pending.length === domains.length) {
      return { ordered: 0, awaitingNameservers: true };
    }

    let ordered = 0;
    let seed = Date.now() % 10_000;
    const taken = new Set<string>();
    for (const [index, domain] of domains.entries()) {
      if (!ready.has(domain.toLowerCase())) continue;
      const platform: "GOOGLE" | "MICROSOFT" =
        index % 2 === 0 ? "GOOGLE" : "MICROSOFT";
      const names = pickUniquePersonNames(perDomain, seed, taken);
      seed += perDomain + 11;
      const batch = names.map((name) => ({
        ...name,
        platform,
        domain_name: domain,
      }));
      const spendReq = {
        key: `inboxkit:isolation:${domain}:${platform}:n${perDomain}`,
        scope: "generic_pool" as const,
        kind: "inboxkit_mailbox_purchase",
        description: `Mailboxes on replacement domain ${domain} (${platform}).`,
        detail: { domain, platform, count: perDomain, actionId: action.id },
      };
      const decision = await this.spend.recordOwnerApproved(spendReq, decidedBy);
      await this.inboxkit.buyMailboxes(batch, {
        workspaceId: workspaceId || undefined,
        useWalletBalance: true,
        idempotencyKey: spendReq.key,
      });
      await this.spend.consume(decision, spendReq);
      const now = new Date().toISOString();
      for (const name of names) {
        this.store.upsertPoolMailbox({
          email: `${name.username}@${domain}`.toLowerCase(),
          domain: domain.toLowerCase(),
          platform,
          firstName: name.first_name,
          lastName: name.last_name,
          status: "warming",
          warmedAt: now,
        });
      }
      ordered += names.length;
    }
    return { ordered, awaitingNameservers: pending.length > 0 };
  }
}
