import {
  InboxKitClient,
  mailboxDomainOf,
  type InboxKitMailbox,
} from "../clients/inboxkit.js";
import { PorkbunClient } from "../clients/porkbun.js";
import type { AppConfig } from "../config.js";
import { generateDomainSpins } from "../lib/domainNaming.js";
import { pickUniquePersonNames } from "../lib/personNames.js";
import {
  platformsFromActionDetail,
  type PoolPlatform,
} from "../lib/retireEspMix.js";
import {
  AWAITING_MAILBOXES,
  AWAITING_PURCHASE,
  needsMailboxResume,
  needsPurchaseRetry,
  purchasedDomainsOf,
} from "../lib/buyResume.js";
import {
  filterReplacementSpins,
  isClientSendingDomain,
  isForbiddenGenericReplacement,
  replacementParentForRetiredDomain,
} from "../lib/retireReplacement.js";
import { ownerFromActionDetail } from "../lib/retireAsk.js";
import type { SpendGateway, SpendRequest } from "../lib/spendGateway.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export interface IsolationBuyResult {
  domains: string[];
  mailboxesOrdered: number;
  awaitingNameservers: boolean;
  /** Set when a mixed plan dropped the other ESP (D175). */
  espSkipReason?: string;
}

/** InboxKit rejects a buy that would put a domain over this many mailboxes. */
export const INBOXKIT_MAX_MAILBOXES_PER_DOMAIN = 5;

export interface MailboxInventoryRow {
  platform: PoolPlatform | null;
}

export interface PlannedMailboxBuy {
  platform: PoolPlatform;
  count: number;
}

/**
 * How many mailboxes to buy after reconciling InboxKit inventory.
 * Never requests more than `maxPerDomain - existing.length`.
 * InboxKit allows only one ESP per domain (D175) — a mixed plan is
 * collapsed before counting so we never POST Microsoft onto Google
 * inventory (the crosslaunchcouse.info isolation-buy-resume loop).
 */
export function planMailboxOrders(
  needed: PoolPlatform[],
  existing: MailboxInventoryRow[],
  maxPerDomain = INBOXKIT_MAX_MAILBOXES_PER_DOMAIN,
): { buy: PlannedMailboxBuy[]; alreadyHave: number } {
  const neededSingle = collapseToOneEsp(
    needed,
    lockedEspFromInventory(existing),
  );
  const needCounts: Record<PoolPlatform, number> = { GOOGLE: 0, MICROSOFT: 0 };
  for (const platform of neededSingle) needCounts[platform] += 1;

  const haveKnown: Record<PoolPlatform, number> = { GOOGLE: 0, MICROSOFT: 0 };
  let unknown = 0;
  for (const row of existing) {
    if (row.platform === "GOOGLE" || row.platform === "MICROSOFT") {
      haveKnown[row.platform] += 1;
    } else {
      unknown += 1;
    }
  }

  const assigned: Record<PoolPlatform, number> = { GOOGLE: 0, MICROSOFT: 0 };
  for (const platform of ["GOOGLE", "MICROSOFT"] as const) {
    assigned[platform] = Math.min(needCounts[platform], haveKnown[platform]);
  }
  // A missing InboxKit platform field must not trigger a re-buy of a
  // domain that is already full (the D149 isolation-buy-resume loop).
  for (const platform of ["GOOGLE", "MICROSOFT"] as const) {
    const short = needCounts[platform] - assigned[platform];
    if (short <= 0 || unknown <= 0) continue;
    const take = Math.min(short, unknown);
    assigned[platform] += take;
    unknown -= take;
  }

  const remaining: Record<PoolPlatform, number> = {
    GOOGLE: Math.max(0, needCounts.GOOGLE - assigned.GOOGLE),
    MICROSOFT: Math.max(0, needCounts.MICROSOFT - assigned.MICROSOFT),
  };
  let room = Math.max(0, maxPerDomain - existing.length);
  const buy: PlannedMailboxBuy[] = [];
  for (const platform of ["GOOGLE", "MICROSOFT"] as const) {
    const count = Math.min(remaining[platform], room);
    if (count > 0) {
      buy.push({ platform, count });
      room -= count;
    }
  }
  return {
    buy,
    alreadyHave: assigned.GOOGLE + assigned.MICROSOFT,
  };
}

/** ESP already present on the domain, if InboxKit reported one. */
export function lockedEspFromInventory(
  existing: MailboxInventoryRow[],
): PoolPlatform | null {
  for (const row of existing) {
    if (row.platform === "GOOGLE" || row.platform === "MICROSOFT") {
      return row.platform;
    }
  }
  return null;
}

/**
 * D175 — InboxKit: one ESP per domain.
 * Locked inventory keeps only that ESP's slots (do not buy extra of the
 * locked platform to stand in for the other — that is new spend).
 * An empty domain fills the planned count with the majority ESP so the
 * first buy cannot mix platforms.
 */
export function collapseToOneEsp(
  needed: PoolPlatform[],
  lock: PoolPlatform | null,
): PoolPlatform[] {
  if (!needed.length) return [];
  if (lock) return needed.filter((platform) => platform === lock);
  const google = needed.filter((platform) => platform === "GOOGLE").length;
  const microsoft = needed.length - google;
  const pick: PoolPlatform = google >= microsoft ? "GOOGLE" : "MICROSOFT";
  return Array.from({ length: needed.length }, () => pick);
}

/** True when InboxKit refused a second ESP on a domain. */
export function isInboxkitOneEspPerDomainError(message: string): boolean {
  return /only one (esp )?platform is allowed per domain|domain already has (google|microsoft).{0,40}mailboxes|cannot create (microsoft|google).{0,40}mailboxes for domain/i.test(
    message,
  );
}

export function oneEspSkipReason(
  domain: string,
  lock: PoolPlatform,
  skipped: PoolPlatform[],
): string {
  const unique = [...new Set(skipped)];
  return (
    `${domain} is locked to ${lock} — skipped ${unique.join("/")} ` +
    `(InboxKit one ESP per domain, D175)`
  );
}

export function isolationMailboxSpendKey(
  domain: string,
  platform: PoolPlatform,
  count: number,
): string {
  return `inboxkit:isolation:${domain}:${platform}:n${count}`;
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
    const existing = purchasedDomainsOf(action);
    if (!existing.length) {
      this.store.upsertIsolationAction({
        ...action,
        status: action.status === "pending" ? action.status : "approved",
        detail: { ...action.detail, phase: AWAITING_PURCHASE },
      });
    }
    const domains =
      existing.length > 0
        ? existing
        : await this.purchaseDomains(quantity, decidedBy, action);

    const mailboxes = await this.orderMailboxes(domains, decidedBy, action);
    this.store.upsertIsolationAction({
      ...this.store.getIsolationAction(action.id)!,
      detail: {
        ...action.detail,
        domains,
        phase: mailboxes.awaitingNameservers
          ? AWAITING_MAILBOXES
          : "complete",
        ...(mailboxes.espSkipReason
          ? { espSkipReason: mailboxes.espSkipReason }
          : {}),
      },
    });
    return {
      domains,
      mailboxesOrdered: mailboxes.ordered,
      awaitingNameservers: mailboxes.awaitingNameservers,
      ...(mailboxes.espSkipReason
        ? { espSkipReason: mailboxes.espSkipReason }
        : {}),
    };
  }

  async resume(): Promise<number> {
    let finished = 0;
    for (const action of this.store.listIsolationActions()) {
      if (needsPurchaseRetry(action)) {
        try {
          const result = await this.run(action);
          this.store.upsertIsolationAction({
            ...this.store.getIsolationAction(action.id)!,
            status: "executed",
            executedAt: new Date().toISOString(),
            error: undefined,
            detail: {
              ...action.detail,
              domains: result.domains,
              phase: result.awaitingNameservers
                ? AWAITING_MAILBOXES
                : "complete",
              ...(result.espSkipReason
                ? { espSkipReason: result.espSkipReason }
                : {}),
            },
          });
          if (!result.awaitingNameservers) finished += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.upsertIsolationAction({
            ...this.store.getIsolationAction(action.id)!,
            status: "approved",
            error: message,
            detail: {
              ...action.detail,
              phase: AWAITING_PURCHASE,
              retryReason: message,
            },
          });
        }
        continue;
      }
      if (!needsMailboxResume(action)) continue;
      const domains = purchasedDomainsOf(action);
      const mailboxes = await this.orderMailboxes(
        domains,
        action.decidedBy ?? "Josh",
        action,
      );
      if (!mailboxes.awaitingNameservers) {
        this.store.upsertIsolationAction({
          ...action,
          detail: {
            ...action.detail,
            phase: "complete",
            ...(mailboxes.espSkipReason
              ? { espSkipReason: mailboxes.espSkipReason }
              : {}),
          },
          status: "executed",
          executedAt: new Date().toISOString(),
          error: undefined,
        });
        finished += 1;
      }
    }
    await this.store.save();
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
    // D161 — client-domain replace spins from that client's brand.
    // The stock path used to always use isolationBuyParentDomain
    // (crosslaunchco.com); that is what bought crosslaunchcotry.info
    // for retired boldercyperpartnerpro.info. Not an ESP-inventory
    // fallback — the parent was hard-coded generic on every retire.
    const sourceDomain = String(
      action.detail.retiredDomain ?? action.detail.domain ?? "",
    ).toLowerCase();
    const owner =
      ownerFromActionDetail(action.detail) ??
      this.store.getDomainOwner(sourceDomain);
    const parent = replacementParentForRetiredDomain(
      sourceDomain,
      this.config,
      {
        requestedParent: String(action.detail.parentDomain ?? ""),
        kind: action.kind,
        owner,
      },
    );
    if (
      sourceDomain &&
      isForbiddenGenericReplacement(sourceDomain, parent, this.config, owner)
    ) {
      throw new Error(
        `Refusing generic replacement parent ${parent} for client domain ${sourceDomain} (D161/D173).`,
      );
    }
    const owned = new Set(
      this.store
        .listPoolMailboxes()
        .map((row) => row.domain.toLowerCase())
        .filter(Boolean),
    );
    const candidates = filterReplacementSpins(
      generateDomainSpins(parent),
      sourceDomain,
      this.config,
      owned,
      owner,
    );
    const bought: string[] = [];
    for (const spin of candidates) {
      if (bought.length >= quantity) break;
      if (
        sourceDomain &&
        isForbiddenGenericReplacement(sourceDomain, spin.domain, this.config, owner)
      ) {
        continue;
      }
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
      const clientHint =
        sourceDomain && isClientSendingDomain(sourceDomain, this.config, owner)
          ? " Client-named spins only — I will not fall back to a generic/pool domain (D161)."
          : "";
      throw new Error(
        `Only found ${bought.length} available replacement domain${bought.length === 1 ? "" : "s"} (needed ${quantity}).${clientHint}`,
      );
    }
    return bought;
  }

  private async orderMailboxes(
    domains: string[],
    decidedBy: string,
    action: IsolationActionRecord,
  ): Promise<{
    ordered: number;
    awaitingNameservers: boolean;
    espSkipReason?: string;
  }> {
    if (!this.inboxkit) {
      throw new Error("InboxKit is not configured, so I cannot buy mailboxes.");
    }
    const workspaceId =
      this.config.genericPoolWorkspaceId || this.config.inboxkitWorkspaceId;
    const perDomain = this.config.isolationMailboxesPerBuyDomain;
    if (this.config.dryRun) {
      return {
        ordered: domains.length * perDomain,
        awaitingNameservers: false,
      };
    }

    const listed = await this.inboxkit.listDomains(workspaceId || undefined, {
      limit: 200,
    });
    const ready = new Set(
      listed
        .filter((row) => InboxKitClient.nameserversReady(row))
        .map((row) => (row.name || row.domain || "").toLowerCase()),
    );

    let ordered = 0;
    let seed = Date.now() % 10_000;
    const taken = new Set<string>();
    const pending: string[] = [];
    const skipReasons: string[] = [];
    for (const [index, domain] of domains.entries()) {
      const rawPlatforms = platformsForDomain(action.detail, perDomain, index);
      const existing = await this.listDomainMailboxes(domain, workspaceId);
      for (const username of existingUsernames(existing)) taken.add(username);
      const inventory = existing.map((row) => ({
        platform: inboxkitMailboxPlatform(row),
      }));
      const lock = lockedEspFromInventory(inventory);
      // D175 — lock to inventory (or majority) before planning buys / spend
      // keys. Mixed GOOGLE+MICROSOFT on one domain is what InboxKit rejected
      // for crosslaunchcouse.info.
      const platforms = collapseToOneEsp(rawPlatforms, lock);
      const skipped = [
        ...new Set(rawPlatforms.filter((p) => !platforms.includes(p))),
      ];
      if (lock && skipped.length) {
        const reason = oneEspSkipReason(domain, lock, skipped);
        skipReasons.push(reason);
        console.log(`[isolation-buy] ${reason}`);
      } else if (!lock && skipped.length) {
        const pick = platforms[0];
        const reason =
          `${domain} empty — provisioning ${pick ?? "none"} only ` +
          `(InboxKit one ESP per domain, D175; skipped ${skipped.join("/")})`;
        skipReasons.push(reason);
        console.log(`[isolation-buy] ${reason}`);
      }
      this.upsertExistingPoolMailboxes(domain, existing, platforms);

      const plan = planMailboxOrders(platforms, inventory);
      const byPlatform = countByPlatform(platforms);
      console.log(
        `[isolation-buy] ${domain} InboxKit inventory=${existing.length}` +
          ` need=${platforms.join("/") || "none"}` +
          (skipped.length ? ` skipped=${skipped.join("/")}` : "") +
          (plan.buy.length
            ? ` buy ${plan.buy.map((row) => `${row.platform}×${row.count}`).join(",")}`
            : " already filled — no buy"),
      );

      if (!plan.buy.length) {
        for (const [platform, count] of byPlatform) {
          await this.consumePlannedMailboxSpend(
            domain,
            platform,
            count,
            decidedBy,
            action.id,
          );
        }
        continue;
      }

      if (!ready.has(domain.toLowerCase())) {
        pending.push(domain);
        continue;
      }

      const now = new Date().toISOString();
      for (const [platform, plannedCount] of byPlatform) {
        const toBuy =
          plan.buy.find((row) => row.platform === platform)?.count ?? 0;
        if (toBuy <= 0) {
          await this.consumePlannedMailboxSpend(
            domain,
            platform,
            plannedCount,
            decidedBy,
            action.id,
          );
          continue;
        }
        const names = pickUniquePersonNames(toBuy, seed, taken);
        seed += toBuy + 11;
        const batch = names.map((name) => ({
          ...name,
          platform,
          domain_name: domain,
        }));
        const spendReq = isolationMailboxSpendRequest(
          domain,
          platform,
          plannedCount,
          action.id,
        );
        const decision = await this.spend.recordOwnerApproved(
          spendReq,
          decidedBy,
        );
        try {
          await this.inboxkit.buyMailboxes(batch, {
            workspaceId: workspaceId || undefined,
            useWalletBalance: true,
            // Remainder buys must not reuse the original n{planned} key —
            // InboxKit already accepted that buy and will not no-op a replay.
            idempotencyKey:
              toBuy === plannedCount
                ? spendReq.key
                : `${spendReq.key}:remain${toBuy}`,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (isInboxkitOneEspPerDomainError(message)) {
            const reason = `${domain}: InboxKit one-ESP rule blocked ${platform} — skipping (D175)`;
            skipReasons.push(reason);
            console.log(`[isolation-buy] ${reason} (${message})`);
            continue;
          }
          throw error;
        }
        await this.spend.consume(decision, spendReq);
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
    }
    await this.store.save();
    return {
      ordered,
      awaitingNameservers: pending.length > 0,
      ...(skipReasons.length ? { espSkipReason: skipReasons.join("; ") } : {}),
    };
  }

  private async listDomainMailboxes(
    domain: string,
    workspaceId: string | undefined,
  ): Promise<InboxKitMailbox[]> {
    const target = domain.toLowerCase();
    const rows = await this.inboxkit!.listMailboxes({
      domain: target,
      keyword: target,
      workspaceId: workspaceId || undefined,
      limit: 200,
    });
    return rows.filter((row) => mailboxDomainOf(row) === target);
  }

  private upsertExistingPoolMailboxes(
    domain: string,
    existing: InboxKitMailbox[],
    platforms: PoolPlatform[],
  ): void {
    const now = new Date().toISOString();
    const fallbackPlatform: PoolPlatform =
      platforms.length === 1
        ? platforms[0]!
        : platforms.find((row) => row === "MICROSOFT") ??
          platforms[0] ??
          "GOOGLE";
    for (const row of existing) {
      const email = inboxkitMailboxEmail(row, domain);
      if (!email) continue;
      const prior = this.store.getPoolMailbox(email);
      const username = (row.username || email.split("@")[0] || "").toLowerCase();
      this.store.upsertPoolMailbox({
        email,
        domain: domain.toLowerCase(),
        platform: inboxkitMailboxPlatform(row) ?? fallbackPlatform,
        firstName:
          prior?.firstName || row.first_name || username || "Mailbox",
        lastName: prior?.lastName || row.last_name || "Box",
        status: prior?.status ?? "warming",
        warmedAt: prior?.warmedAt ?? inboxkitWarmedAt(row, now),
        ...(prior?.smartleadAccountId
          ? { smartleadAccountId: prior.smartleadAccountId }
          : {}),
        ...(prior?.copyCanary ? { copyCanary: true } : {}),
      });
    }
  }

  /**
   * A prior InboxKit buy that crashed before consume/phase-complete still
   * has an approved (or already-consumed) spend row. Consume the planned
   * key when it is still approved; never open a new spend cycle.
   */
  private async consumePlannedMailboxSpend(
    domain: string,
    platform: PoolPlatform,
    plannedCount: number,
    decidedBy: string,
    actionId: string,
  ): Promise<void> {
    const spendReq = isolationMailboxSpendRequest(
      domain,
      platform,
      plannedCount,
      actionId,
    );
    const existing =
      this.store.getLatestSpendApprovalForRequest(spendReq.key) ??
      this.store.getSpendApproval(spendReq.key);
    if (existing?.status === "consumed") return;
    const decision = await this.spend.recordOwnerApproved(spendReq, decidedBy);
    await this.spend.consume(decision, spendReq);
  }
}

function platformsForDomain(
  detail: Record<string, unknown>,
  perDomain: number,
  index: number,
): PoolPlatform[] {
  const fromDetail = platformsFromActionDetail(detail, perDomain);
  // Default is a single ESP for the whole domain (InboxKit cannot mix).
  // Alternating GOOGLE/MICROSOFT used to plan a second platform buy that
  // always failed once the first platform was provisioned (D175).
  const fallback: PoolPlatform = index % 2 === 0 ? "GOOGLE" : "MICROSOFT";
  const platforms = (
    fromDetail ?? Array.from({ length: perDomain }, () => fallback)
  ).slice(0, perDomain);
  if (platforms.length) return platforms;
  return Array.from({ length: perDomain }, () => fallback);
}

function countByPlatform(platforms: PoolPlatform[]): Map<PoolPlatform, number> {
  const byPlatform = new Map<PoolPlatform, number>();
  for (const platform of platforms) {
    byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + 1);
  }
  return byPlatform;
}

function isolationMailboxSpendRequest(
  domain: string,
  platform: PoolPlatform,
  count: number,
  actionId: string,
): SpendRequest {
  return {
    key: isolationMailboxSpendKey(domain, platform, count),
    scope: "generic_pool",
    kind: "inboxkit_mailbox_purchase",
    description: `Mailboxes on replacement domain ${domain} (${platform}).`,
    detail: { domain, platform, count, actionId },
  };
}

function inboxkitMailboxEmail(row: InboxKitMailbox, domain: string): string {
  const fromFields = (row.email || row.address || "").toLowerCase();
  if (fromFields.includes("@")) return fromFields;
  const username = (row.username || "").toLowerCase();
  if (username) return `${username}@${domain.toLowerCase()}`;
  return "";
}

function inboxkitMailboxPlatform(row: InboxKitMailbox): PoolPlatform | null {
  const raw = String(row.platform ?? "");
  if (/micro|outlook/i.test(raw)) return "MICROSOFT";
  if (/google|gmail/i.test(raw)) return "GOOGLE";
  return null;
}

function inboxkitWarmedAt(row: InboxKitMailbox, fallback: string): string {
  const raw = row as Record<string, unknown>;
  const created = raw.created_at ?? raw.createdAt ?? raw.created ?? raw.purchased_at;
  if (typeof created === "string" || typeof created === "number") {
    const ms = Date.parse(String(created));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

function existingUsernames(rows: InboxKitMailbox[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const email = (row.email || row.address || "").toLowerCase();
    const user = email.includes("@") ? email.split("@")[0] : "";
    if (user) out.push(user);
    if (row.username) out.push(String(row.username).toLowerCase());
  }
  return out;
}
