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
  filterReplacementSpins,
  isClientSendingDomain,
  isForbiddenGenericReplacement,
  replacementParentForRetiredDomain,
} from "../lib/retireReplacement.js";
import type { SpendGateway, SpendRequest } from "../lib/spendGateway.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export interface IsolationBuyResult {
  domains: string[];
  mailboxesOrdered: number;
  awaitingNameservers: boolean;
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
 * InboxKit allows only one ESP platform per domain — if inventory already
 * has Google or Microsoft, all remaining buys stay on that platform.
 */
export function planMailboxOrders(
  needed: PoolPlatform[],
  existing: MailboxInventoryRow[],
  maxPerDomain = INBOXKIT_MAX_MAILBOXES_PER_DOMAIN,
): { buy: PlannedMailboxBuy[]; alreadyHave: number } {
  const lock = lockedEspFromInventory(existing);
  const neededSingle = collapseToOneEsp(needed, lock);

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

/** ESP already present on the domain, if any. */
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
 * InboxKit: one ESP per domain. Collapse a mixed plan onto the locked
 * platform (or the majority / first platform when the domain is empty).
 */
export function collapseToOneEsp(
  needed: PoolPlatform[],
  lock: PoolPlatform | null,
): PoolPlatform[] {
  if (!needed.length) return [];
  if (lock) {
    return Array.from({ length: needed.length }, () => lock);
  }
  const google = needed.filter((p) => p === "GOOGLE").length;
  const microsoft = needed.length - google;
  const pick: PoolPlatform =
    google >= microsoft ? "GOOGLE" : "MICROSOFT";
  return Array.from({ length: needed.length }, () => pick);
}

/** True when InboxKit refused a second ESP on a domain. */
export function isInboxkitOneEspPerDomainError(message: string): boolean {
  return /only one (esp )?platform is allowed per domain|domain already has (google|microsoft).*mailboxes/i.test(
    message,
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
    // D161 — client-domain replace spins from that client's brand.
    // The stock path used to always use isolationBuyParentDomain
    // (crosslaunchco.com); that is what bought crosslaunchcotry.info
    // for retired boldercyperpartnerpro.info. Not an ESP-inventory
    // fallback — the parent was hard-coded generic on every retire.
    const sourceDomain = String(
      action.detail.retiredDomain ?? action.detail.domain ?? "",
    ).toLowerCase();
    const parent = replacementParentForRetiredDomain(
      sourceDomain,
      this.config,
      {
        requestedParent: String(action.detail.parentDomain ?? ""),
        kind: action.kind,
      },
    );
    if (
      sourceDomain &&
      isForbiddenGenericReplacement(sourceDomain, parent, this.config)
    ) {
      throw new Error(
        `Refusing generic replacement parent ${parent} for client domain ${sourceDomain} (D161).`,
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
    );
    const bought: string[] = [];
    for (const spin of candidates) {
      if (bought.length >= quantity) break;
      if (
        sourceDomain &&
        isForbiddenGenericReplacement(sourceDomain, spin.domain, this.config)
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
        sourceDomain && isClientSendingDomain(sourceDomain, this.config)
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

    let ordered = 0;
    let seed = Date.now() % 10_000;
    const taken = new Set<string>();
    const pending: string[] = [];
    for (const [index, domain] of domains.entries()) {
      const rawPlatforms = platformsForDomain(action.detail, perDomain, index);
      const existing = await this.listDomainMailboxes(domain, workspaceId);
      for (const username of existingUsernames(existing)) taken.add(username);
      const inventory = existing.map((row) => ({
        platform: inboxkitMailboxPlatform(row),
      }));
      // InboxKit: one ESP per domain. Lock to inventory (or majority) before
      // planning buys / spend keys — a mixed GOOGLE+MICROSOFT plan was what
      // blew up crosslaunchcouse.info ("already has Google Workspace").
      const platforms = collapseToOneEsp(
        rawPlatforms,
        lockedEspFromInventory(inventory),
      );
      this.upsertExistingPoolMailboxes(domain, existing, platforms);

      const plan = planMailboxOrders(platforms, inventory);
      const byPlatform = countByPlatform(platforms);
      console.log(
        `[isolation-buy] ${domain} InboxKit inventory=${existing.length}` +
          ` need=${platforms.join("/") || "none"}` +
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
            console.log(
              `[isolation-buy] ${domain}: InboxKit one-ESP rule blocked ${platform} — skipping (${message})`,
            );
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
    return { ordered, awaitingNameservers: pending.length > 0 };
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
  // always failed once the first platform was provisioned.
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
