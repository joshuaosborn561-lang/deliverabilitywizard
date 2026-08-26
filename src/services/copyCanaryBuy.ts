import { InboxKitClient } from "../clients/inboxkit.js";
import { PorkbunClient } from "../clients/porkbun.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { accountEmail } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
import {
  COPY_CANARY_FLEET_DOMAIN_COUNT,
  COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN,
  COPY_CANARY_FLEET_SIZE,
  domainsFromCanaryBuyActions,
  platformForCanaryDomainIndex,
  type CopyCanaryFleetRecord,
} from "../lib/copyCanaryFleet.js";
import { generateDomainSpins } from "../lib/domainNaming.js";
import { sleep } from "../lib/http.js";
import { pickUniquePersonNames } from "../lib/personNames.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export interface CopyCanaryBuyResult {
  domains: string[];
  googleDomain?: string;
  microsoftDomain?: string;
  emails: string[];
  mailboxesOrdered: number;
  awaitingNameservers: boolean;
  awaitingExport: boolean;
}

export interface CopyCanaryAdoptResult {
  /** Candidate mailboxes seen in InboxKit that look like a manual fleet buy. */
  found: string[];
  /** Emails registered as the unwarmed canary fleet this pass. */
  adopted: string[];
  /** Fleet emails with a Smartlead account id after export/mapping. */
  mapped: number;
  ready: boolean;
  /** Why nothing was adopted, when found/adopted are empty. */
  reason?: string;
}

/**
 * D54 — Josh-tapped purchase of the dedicated unwarmed canary fleet.
 * Two domains, three inboxes each, Google then Outlook. Warmup stays off.
 */
export class CopyCanaryBuyService {
  constructor(
    private readonly config: AppConfig,
    private readonly inboxkit: InboxKitClient | null,
    private readonly porkbun: PorkbunClient | null,
    private readonly smartlead: SmartleadClient,
    private readonly store: StateStore,
    private readonly spend: SpendGateway,
  ) {}

  async run(action: IsolationActionRecord): Promise<CopyCanaryBuyResult> {
    this.patchFleet({
      status: "buying",
      actionId: action.id,
    });
    const decidedBy = action.decidedBy ?? "Josh";
    const already = domainsFromCanaryBuyActions(
      this.store.listIsolationActions(),
    );
    const fleetDomains = this.store.getCopyCanaryFleet()?.domains ?? [];
    const domains =
      Array.isArray(action.detail.domains) && action.detail.domains.length
        ? (action.detail.domains as string[])
        : fleetDomains.length
          ? fleetDomains
          : already?.domains.length
            ? already.domains
            : await this.purchaseDomains(decidedBy, action);

    const googleDomain = domains[0]?.toLowerCase();
    const microsoftDomain = domains[1]?.toLowerCase();
    this.patchFleet({
      status: "awaiting_mailboxes",
      domains,
      googleDomain,
      microsoftDomain,
      actionId: action.id,
    });

    const mailboxes = await this.orderMailboxes(domains, decidedBy, action);
    const exported = await this.exportAndDisableWarmup(domains);
    const fleet = this.store.getCopyCanaryFleet();
    const emails = fleet?.emails ?? [];
    const ready =
      !mailboxes.awaitingNameservers &&
      emails.length >= COPY_CANARY_FLEET_SIZE &&
      exported.mapped >= COPY_CANARY_FLEET_SIZE;
    this.patchFleet({
      status: mailboxes.awaitingNameservers
        ? "awaiting_mailboxes"
        : ready
          ? "ready"
          : "awaiting_export",
      domains,
      googleDomain,
      microsoftDomain,
      emails,
      actionId: action.id,
    });
    this.store.upsertIsolationAction({
      ...this.store.getIsolationAction(action.id)!,
      detail: {
        ...action.detail,
        domains,
        emails,
        phase: mailboxes.awaitingNameservers
          ? "awaiting_mailboxes"
          : ready
            ? "complete"
            : "awaiting_export",
      },
    });
    return {
      domains,
      googleDomain,
      microsoftDomain,
      emails,
      mailboxesOrdered: mailboxes.ordered,
      awaitingNameservers: mailboxes.awaitingNameservers,
      awaitingExport: !ready && !mailboxes.awaitingNameservers,
    };
  }

  async resume(): Promise<number> {
    let finished = 0;
    for (const action of this.store.listIsolationActions()) {
      if (action.kind !== "buy_canary_fleet") continue;
      if (action.status !== "executed" && action.status !== "approved") continue;
      const phase = String(action.detail.phase ?? "");
      if (phase !== "awaiting_mailboxes" && phase !== "awaiting_export") continue;
      const domains = Array.isArray(action.detail.domains)
        ? (action.detail.domains as string[])
        : [];
      if (!domains.length) continue;
      const mailboxes = await this.orderMailboxes(
        domains,
        action.decidedBy ?? "Josh",
        action,
      );
      if (mailboxes.awaitingNameservers) continue;
      const exported = await this.exportAndDisableWarmup(domains);
      const fleet = this.store.getCopyCanaryFleet();
      const emails = fleet?.emails ?? [];
      const ready =
        emails.length >= COPY_CANARY_FLEET_SIZE &&
        exported.mapped >= COPY_CANARY_FLEET_SIZE;
      this.patchFleet({
        status: ready ? "ready" : "awaiting_export",
        domains,
        googleDomain: domains[0]?.toLowerCase(),
        microsoftDomain: domains[1]?.toLowerCase(),
        emails,
        actionId: action.id,
      });
      this.store.upsertIsolationAction({
        ...action,
        detail: {
          ...action.detail,
          phase: ready ? "complete" : "awaiting_export",
          emails,
        },
        status: "executed",
        executedAt: action.executedAt ?? new Date().toISOString(),
      });
      if (ready) finished += 1;
    }
    if (finished) await this.store.save();
    return finished;
  }

  /**
   * D86 — adopt a fleet Josh bought by hand in InboxKit.
   *
   * The buy flow assumes the app made the purchase, so a manual buy used to
   * strand six perfectly good unwarmed inboxes: no fleet record, warmup on
   * whatever InboxKit defaults to, no canary tests. This pass treats the
   * InboxKit workspace as the record of what Josh bought: any mailbox on a
   * domain that is not generic-pool plan, not a pre-warmed fleet, not the
   * isolation domain, and not already a known non-canary pool row is a
   * manual canary purchase. Adopted mailboxes are registered `copyCanary`
   * (never staffing supply), exported to Smartlead if missing, and warmup
   * is turned off (D83). Test attachment stays with the normal sweep.
   */
  async adoptManualPurchase(): Promise<CopyCanaryAdoptResult | null> {
    const fleet = this.store.getCopyCanaryFleet();
    if (fleet?.status === "ready" && !this.store.getCanaryFleetDown()) {
      return null;
    }
    // An app-made purchase mid-flight is resume()'s job, not adoption's.
    for (const action of this.store.listIsolationActions()) {
      if (action.kind !== "buy_canary_fleet") continue;
      if (action.status !== "approved" && action.status !== "executed") continue;
      const phase = String(action.detail.phase ?? "");
      if (phase === "awaiting_mailboxes" || phase === "awaiting_export") {
        return null;
      }
    }
    if (!this.inboxkit) {
      return {
        found: [],
        adopted: [],
        mapped: 0,
        ready: false,
        reason: "InboxKit is not configured",
      };
    }

    const workspaceId =
      this.config.genericPoolWorkspaceId || this.config.inboxkitWorkspaceId;
    const rows = await this.inboxkit.listAllMailboxes(workspaceId || undefined);
    const planDomains = new Set(
      GENERIC_POOL_PLAN.domains.map((d) => d.domain.toLowerCase()),
    );
    const excludedDomains = new Set([
      ...this.config.extraGenericDomains.map((d) => d.toLowerCase()),
      ...(this.config.isolationDomain
        ? [this.config.isolationDomain.toLowerCase()]
        : []),
    ]);

    const candidates: Array<{
      email: string;
      domain: string;
      platform: "GOOGLE" | "MICROSOFT";
      firstName: string;
      lastName: string;
    }> = [];
    for (const row of rows) {
      const domain = (row.domain_name || row.domain || "").toLowerCase();
      const username = (row.username || "").toLowerCase();
      const email = (
        row.email ||
        row.address ||
        (username && domain ? `${username}@${domain}` : "")
      ).toLowerCase();
      if (!email || !domain) continue;
      if (planDomains.has(domain) || excludedDomains.has(domain)) continue;
      const existing = this.store.getPoolMailbox(email);
      if (existing && !existing.copyCanary) continue;
      candidates.push({
        email,
        domain,
        platform: /micro|outlook/i.test(String(row.platform ?? ""))
          ? "MICROSOFT"
          : "GOOGLE",
        firstName: row.first_name || username || "Canary",
        lastName: row.last_name || "Box",
      });
    }

    const found = candidates.map((c) => c.email);
    if (!candidates.length) {
      return {
        found,
        adopted: [],
        mapped: this.fleetMappedCount(),
        ready: false,
        reason:
          "No unassigned mailboxes in the InboxKit workspace look like a canary buy",
      };
    }
    if (candidates.length > COPY_CANARY_FLEET_SIZE * 2) {
      return {
        found,
        adopted: [],
        mapped: this.fleetMappedCount(),
        ready: false,
        reason: `${candidates.length} candidate mailboxes is too many to adopt blind — expected about ${COPY_CANARY_FLEET_SIZE}`,
      };
    }

    for (const candidate of candidates) {
      const existing = this.store.getPoolMailbox(candidate.email);
      this.store.upsertPoolMailbox({
        email: candidate.email,
        domain: candidate.domain,
        platform: candidate.platform,
        smartleadAccountId: existing?.smartleadAccountId,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        status: "available",
        copyCanary: true,
      });
    }
    // Planned-but-never-bought fleet emails (dry-run leftovers) give way to
    // what InboxKit says actually exists. Mapped rows are never dropped.
    const adoptedSet = new Set(found);
    for (const email of fleet?.emails ?? []) {
      if (adoptedSet.has(email)) continue;
      const row = this.store.getPoolMailbox(email);
      if (row?.copyCanary && !row.smartleadAccountId) {
        this.store.removePoolMailbox(email);
      }
    }

    const domains = [...new Set(candidates.map((c) => c.domain))];
    const googleDomain = domains.find((d) =>
      candidates.some((c) => c.domain === d && c.platform === "GOOGLE"),
    );
    const microsoftDomain = domains.find((d) =>
      candidates.some((c) => c.domain === d && c.platform === "MICROSOFT"),
    );
    this.patchFleet({
      status: "awaiting_export",
      domains,
      googleDomain,
      microsoftDomain,
      emails: found,
    });

    const exported = await this.exportAndDisableWarmup(domains);
    const ready = exported.mapped >= candidates.length;
    this.patchFleet({ status: ready ? "ready" : "awaiting_export" });
    await this.store.save();
    console.log(
      `[copy-canary-adopt] adopted=${found.length} mapped=${exported.mapped} ready=${ready} domains=${domains.join(",")}`,
    );
    return {
      found,
      adopted: found,
      mapped: exported.mapped,
      ready,
    };
  }

  private async purchaseDomains(
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
    const fleet = this.store.getCopyCanaryFleet();
    for (const domain of fleet?.domains ?? []) owned.add(domain.toLowerCase());
    const candidates = generateDomainSpins(parent).filter(
      (spin) => !owned.has(spin.domain),
    );
    const bought: string[] = [];
    for (const spin of candidates) {
      if (bought.length >= COPY_CANARY_FLEET_DOMAIN_COUNT) break;
      const check = await this.porkbun.checkDomainThrottled(spin.domain);
      if (!check.available) continue;
      const cents = PorkbunClient.priceToCents(check.price);
      if (cents == null) {
        throw new Error(`Porkbun did not quote a price for ${spin.domain}`);
      }
      const spendReq = {
        key: `porkbun:canary-fleet:${spin.domain}`,
        scope: "generic_pool" as const,
        kind: "porkbun_domain",
        description: `Unwarmed canary domain ${spin.domain} (warmup stays off; campaign copy only).`,
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
    if (bought.length < COPY_CANARY_FLEET_DOMAIN_COUNT) {
      throw new Error(
        `Only found ${bought.length} available canary domain${bought.length === 1 ? "" : "s"} (needed ${COPY_CANARY_FLEET_DOMAIN_COUNT}).`,
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
    const perDomain = COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN;
    if (this.config.dryRun) {
      this.registerPlanned(domains, Date.now() % 10_000);
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
    const emails: string[] = [
      ...(this.store.getCopyCanaryFleet()?.emails ?? []),
    ];
    for (const [index, domain] of domains.entries()) {
      if (!ready.has(domain.toLowerCase())) continue;
      if (
        emails.some((email) => email.endsWith(`@${domain.toLowerCase()}`))
      ) {
        continue;
      }
      const platform = platformForCanaryDomainIndex(index);
      const names = pickUniquePersonNames(perDomain, seed, taken);
      seed += perDomain + 11;
      const batch = names.map((name) => ({
        ...name,
        platform,
        domain_name: domain,
      }));
      const spendReq = {
        key: `inboxkit:canary-fleet:${domain}:${platform}:n${perDomain}`,
        scope: "generic_pool" as const,
        kind: "inboxkit_mailbox_purchase",
        description: `Unwarmed canary mailboxes on ${domain} (${platform}). Warmup stays off.`,
        detail: { domain, platform, count: perDomain, actionId: action.id },
      };
      const decision = await this.spend.recordOwnerApproved(spendReq, decidedBy);
      await this.inboxkit.buyMailboxes(batch, {
        workspaceId: workspaceId || undefined,
        useWalletBalance: true,
        idempotencyKey: spendReq.key,
      });
      await this.spend.consume(decision, spendReq);
      for (const name of names) {
        const email = `${name.username}@${domain}`.toLowerCase();
        emails.push(email);
        this.store.upsertPoolMailbox({
          email,
          domain: domain.toLowerCase(),
          platform,
          firstName: name.first_name,
          lastName: name.last_name,
          status: "available",
          copyCanary: true,
        });
      }
      ordered += names.length;
    }
    this.patchFleet({
      domains,
      googleDomain: domains[0]?.toLowerCase(),
      microsoftDomain: domains[1]?.toLowerCase(),
      emails,
      actionId: action.id,
    });
    return { ordered, awaitingNameservers: pending.length > 0 };
  }

  private registerPlanned(domains: string[], seed: number): void {
    const taken = new Set<string>();
    const emails: string[] = [];
    let nextSeed = seed;
    for (const [index, domain] of domains.entries()) {
      const platform = platformForCanaryDomainIndex(index);
      const names = pickUniquePersonNames(
        COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN,
        nextSeed,
        taken,
      );
      nextSeed += COPY_CANARY_FLEET_MAILBOXES_PER_DOMAIN + 11;
      for (const name of names) {
        const email = `${name.username}@${domain}`.toLowerCase();
        emails.push(email);
        this.store.upsertPoolMailbox({
          email,
          domain: domain.toLowerCase(),
          platform,
          firstName: name.first_name,
          lastName: name.last_name,
          status: "available",
          copyCanary: true,
        });
      }
    }
    this.patchFleet({
      domains,
      googleDomain: domains[0]?.toLowerCase(),
      microsoftDomain: domains[1]?.toLowerCase(),
      emails,
    });
  }

  private async exportAndDisableWarmup(
    domains: string[],
  ): Promise<{ mapped: number }> {
    const domainSet = new Set(domains.map((row) => row.toLowerCase()));
    await this.mapSmartleadIds(domainSet);
    if (this.config.dryRun) {
      return { mapped: this.fleetMappedCount() };
    }
    if (!this.inboxkit) return { mapped: this.fleetMappedCount() };

    const workspaceId =
      this.config.genericPoolWorkspaceId || this.config.inboxkitWorkspaceId;
    const sequencerUid =
      this.store.getPoolProvision().sequencerUid ||
      GENERIC_POOL_PLAN.smartleadSequencerUid;
    if (sequencerUid) {
      try {
        const mailboxes = await this.inboxkit.listAllMailboxes(
          workspaceId || undefined,
        );
        const inSmartlead = new Set(
          this.store
            .listPoolMailboxes()
            .filter((row) => row.copyCanary && row.smartleadAccountId)
            .map((row) => row.email.toLowerCase()),
        );
        const missing = mailboxes
          .filter((row) => {
            const domain = (
              row.domain_name ||
              row.domain ||
              ""
            ).toLowerCase();
            if (!domainSet.has(domain)) return false;
            const email = `${row.username ?? ""}@${domain}`.toLowerCase();
            return Boolean(row.uid || row.id) && !inSmartlead.has(email);
          })
          .map((row) => row.uid || row.id)
          .filter((uid): uid is string => Boolean(uid));
        if (missing.length) {
          await this.inboxkit.exportMailboxesToSequencer(
            sequencerUid,
            missing,
            workspaceId || undefined,
          );
        }
      } catch (error) {
        console.warn("[copy-canary-buy] export failed", error);
      }
    }
    await this.mapSmartleadIds(domainSet);
    await this.disableWarmup(domainSet);
    return { mapped: this.fleetMappedCount() };
  }

  private async mapSmartleadIds(domains: Set<string>): Promise<void> {
    let accounts: Awaited<
      ReturnType<SmartleadClient["listAllEmailAccounts"]>
    > = [];
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: false,
      });
    } catch {
      return;
    }
    const emails = [...(this.store.getCopyCanaryFleet()?.emails ?? [])];
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email) continue;
      const domain = email.split("@")[1] ?? "";
      if (!domains.has(domain) && !emails.includes(email)) continue;
      const existing = this.store.getPoolMailbox(email);
      if (existing) {
        this.store.upsertPoolMailbox({
          ...existing,
          smartleadAccountId: account.id,
          copyCanary: true,
        });
      }
      if (!emails.includes(email) && domains.has(domain)) emails.push(email);
    }
    this.patchFleet({ emails });
  }

  private async disableWarmup(domains: Set<string>): Promise<void> {
    const accounts = await this.smartlead
      .listAllEmailAccounts({ fetchCampaigns: false })
      .catch(() => []);
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email) continue;
      const domain = email.split("@")[1] ?? "";
      if (!this.store.isCopyCanary(email) && !domains.has(domain)) continue;
      try {
        await this.smartlead.configureWarmup(account.id, {
          warmup_enabled: false,
          total_warmup_per_day: this.config.warmupTotalPerDay,
          daily_rampup: this.config.warmupDailyRampup,
          reply_rate_percentage: this.config.warmupReplyRatePercentage,
        });
        await sleep(120);
      } catch (error) {
        console.warn("[copy-canary-buy] warmup-off failed", email, error);
      }
    }
  }

  private fleetMappedCount(): number {
    const emails = this.store.getCopyCanaryFleet()?.emails ?? [];
    return emails.filter((email) =>
      Boolean(this.store.getPoolMailbox(email)?.smartleadAccountId),
    ).length;
  }

  private patchFleet(patch: Partial<CopyCanaryFleetRecord>): void {
    const current = this.store.getCopyCanaryFleet();
    this.store.setCopyCanaryFleet({
      status: current?.status ?? "buying",
      domains: current?.domains ?? [],
      emails: current?.emails ?? [],
      googleDomain: current?.googleDomain,
      microsoftDomain: current?.microsoftDomain,
      actionId: current?.actionId,
      updatedAt: new Date().toISOString(),
      ...patch,
    });
  }
}
