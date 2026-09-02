import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { sleep } from "../lib/http.js";
import {
  assignClientCohorts,
  isOffWeek,
  onWeekCohort,
  type RestCohort,
} from "../lib/restCohort.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isExcluded } from "./campaignTopUp.js";
import {
  dropMembership,
  fetchInventory,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";
import { activeHoldUntilDate, owesWarmup, tagNames } from "./warmupGate.js";

/**
 * D43 — per-client A/B rest. Half of that client's inboxes sit for two
 * weeks (off live campaigns, warmup on). Generics are not in this loop.
 *
 * D169 — off-week detach is ACTIVE + PAUSED + STOPPED. A PAUSED/STOPPED
 * membership still holds the box in the A/B pod; filtering bench to
 * ACTIVE only left BCP With Team (PAUSED) and STOPPED client-named
 * campaigns hoarding the off-week half, so ACTIVE stayed thin. On-week
 * restore still targets every ACTIVE client campaign (D59) and also
 * clears leftover PAUSED/STOPPED attachments so they cannot trap the
 * on-week half. Excluded / canary / pod-control shells stay untouched.
 *
 * D154 — on-week restore must not re-staff inboxes that still owe warmup.
 * Health runs client-rest *before* the warmup gate every pass; without this
 * check, under-warmed Parlay/Culturefits boxes were put back on every
 * ACTIVE client campaign each cycle (the D143 "boomerang"), then pulled
 * again — an in-app fight, not an outside sync.
 */

/** Live-client statuses rest may detach from (D169). COMPLETED/DRAFT stay. */
export const REST_DETACH_STATUSES = new Set(["ACTIVE", "PAUSED", "STOPPED"]);

/**
 * True when A/B rest may remove this membership. PAUSED and STOPPED are
 * included — they are not sending, but they still occupy the pod (D169).
 * Shells and TOP_UP_EXCLUDE_CAMPAIGNS stay out via `isExcluded`.
 */
export function isRestDetachableCampaign(
  campaign:
    | { id: number; name?: string | null; status?: string | null }
    | undefined,
  excluded: string[],
): boolean {
  if (!campaign) return false;
  const status = String(campaign.status ?? "").toUpperCase();
  if (!REST_DETACH_STATUSES.has(status)) return false;
  if (isExcluded(campaign, excluded)) return false;
  return true;
}

export interface ClientRestResult {
  dryRun: boolean;
  onWeekCohort: RestCohort;
  examined: number;
  benched: Array<{ email: string; campaignIds: number[] }>;
  restored: Array<{ email: string; campaignIds: number[] }>;
  skipped: string[];
  errors: string[];
}

/**
 * True only when every *known* campaign this inbox is on is excluded.
 * Unknown / leftover campaign ids do not count as excluded (D63) — those
 * inboxes still belong in the A/B rest loop.
 */
export function isExcludedOnlyMembership(
  campaignIds: number[],
  campaignById: Map<number, { id: number; name?: string | null }>,
  excluded: string[],
): boolean {
  const known = campaignIds
    .map((id) => campaignById.get(id))
    .filter((campaign): campaign is { id: number; name?: string | null } =>
      Boolean(campaign),
    )
    .filter((campaign) => !isAnyShellCampaign(campaign));
  return (
    known.length > 0 &&
    known.every((campaign) => isExcluded(campaign, excluded))
  );
}

export function clientRestGroupKey(
  account: SmartleadAccountWithCampaigns,
  email: string,
  campaignClientById: Map<number, number | null | undefined>,
): string | null {
  if (typeof account.client_id === "number" && Number.isFinite(account.client_id)) {
    return `id:${account.client_id}`;
  }
  for (const id of campaignIdsOf(account)) {
    const clientId = campaignClientById.get(id);
    if (typeof clientId === "number" && Number.isFinite(clientId)) {
      return `id:${clientId}`;
    }
  }
  const domain = email.split("@")[1] ?? "";
  if (isBcpOwnedDomain(domain)) return "bcp";
  return null;
}

export class ClientRestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; now?: Date; inventory?: InventorySnapshot } = {},
  ): Promise<ClientRestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: ClientRestResult = {
      dryRun,
      onWeekCohort: onWeekCohort(now),
      examined: 0,
      benched: [],
      restored: [],
      skipped: [],
      errors: [],
    };

    if (!this.config.enableClientRest) {
      console.log("[client-rest] Disabled (ENABLE_CLIENT_REST=false)");
      return result;
    }

    const { campaigns, accounts } =
      opts.inventory ?? (await fetchInventory(this.smartlead));

    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c.client_id]),
    );
    const activeByClient = new Map<number, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      const clientId = campaign.client_id;
      if (typeof clientId !== "number") continue;
      const list = activeByClient.get(clientId) ?? [];
      list.push(campaign);
      activeByClient.set(clientId, list);
    }

    const membership = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      for (const id of campaignIdsOf(account)) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
      }
    }

    const candidates: Array<{
      account: SmartleadAccountWithCampaigns;
      email: string;
      groupKey: string;
    }> = [];
    const byGroup = new Map<string, string[]>();

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      const domain = email.split("@")[1]?.toLowerCase();
      if (
        isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))
      ) {
        result.skipped.push(`${email}: retired domain`);
        continue;
      }
      if (isGenericMailbox(account, email, this.config, this.state)) continue;
      const groupKey = clientRestGroupKey(account, email, campaignClientById);
      if (!groupKey) {
        result.skipped.push(`${email}: no client group`);
        continue;
      }
      const onCampaigns = campaignIdsOf(account);
      const onlyExcluded = isExcludedOnlyMembership(
        onCampaigns,
        campaignById,
        this.config.topUpExcludeCampaigns,
      );
      if (onlyExcluded) {
        result.skipped.push(`${email}: excluded campaign`);
        continue;
      }
      candidates.push({ account, email, groupKey });
      const list = byGroup.get(groupKey) ?? [];
      list.push(email);
      byGroup.set(groupKey, list);
    }

    const cohortByEmail = new Map<string, RestCohort>();
    for (const [, emails] of byGroup) {
      for (const [email, cohort] of assignClientCohorts(emails)) {
        cohortByEmail.set(email, cohort);
      }
    }

    for (const { account, email, groupKey } of candidates) {
      result.examined += 1;
      const cohort = cohortByEmail.get(email);
      if (!cohort) continue;

      if (activeHoldUntilDate(tagNames(account))) {
        result.skipped.push(`${email}: held`);
        continue;
      }

      const off = isOffWeek(cohort, now);
      const existing = this.state.getRestingInbox(email);
      if (existing?.kind === "generic") continue;

      // D169 — detachable = ACTIVE + PAUSED + STOPPED. The old ACTIVE-only
      // filter left off-week boxes parked on PAUSED/STOPPED forever.
      const detachable = campaignIdsOf(account).filter((id) =>
        isRestDetachableCampaign(
          campaignById.get(id),
          this.config.topUpExcludeCampaigns,
        ),
      );
      const alreadyOnActive = detachable.filter((id) => {
        const campaign = campaignById.get(id);
        return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
      });

      if (off) {
        if (!detachable.length && existing) continue;
        const removed = await this.detachFromCampaigns(
          account,
          email,
          detachable,
          membership,
          dryRun,
          result,
        );
        if (removed.length || !existing) {
          const record = {
            accountId: account.id,
            email,
            clientId: groupKey,
            cohort,
            kind: "client" as const,
            restingSince: existing?.restingSince ?? now.toISOString(),
            removedFromCampaigns: [
              ...new Set([
                ...(existing?.removedFromCampaigns ?? []),
                ...removed,
                ...detachable,
              ]),
            ],
            lastSameEspInbox: existing?.lastSameEspInbox ?? null,
          };
          if (!dryRun) this.state.markRestingInbox(record);
          if (removed.length) {
            result.benched.push({ email, campaignIds: removed });
          }
        }
        continue;
      }

      // D154 / D139 — under-warmed inboxes are not on-week staff. Restoring
      // them onto every ACTIVE client campaign handed the warmup gate its
      // next pull every health pass (Parlay ×16, Culturefits ×1).
      if (owesWarmup(account, email, this.config, this.state)) {
        result.skipped.push(`${email}: owes warmup (D139)`);
        continue;
      }

      const clientId =
        typeof account.client_id === "number" ? account.client_id : null;
      const parsedId = groupKey.startsWith("id:")
        ? Number(groupKey.slice(3))
        : clientId;
      // D59 — on-week (B this fortnight) sits on every ACTIVE campaign for
      // that client, not just the campaigns it happened to be on before a hold.
      const targets = this.onWeekTargets(
        Number.isFinite(parsedId) ? parsedId : null,
        groupKey,
        campaigns as SmartleadCampaign[],
        activeByClient,
      );
      const added: number[] = [];
      for (const campaignId of targets) {
        if (alreadyOnActive.includes(campaignId)) continue;
        try {
          if (!dryRun) {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [
              account.id,
            ]);
            await sleep(150);
            recordMembership(account, campaignId);
          }
          added.push(campaignId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`${email} restore #${campaignId}: ${message}`);
        }
      }
      // D169 hygiene — on-week belongs on ACTIVE. Leftover PAUSED/STOPPED
      // attachments are what starved the live pool (BCP With Team).
      const leftoverPausedOrStopped = detachable.filter((id) => {
        const campaign = campaignById.get(id);
        return String(campaign?.status ?? "").toUpperCase() !== "ACTIVE";
      });
      const cleared = await this.detachFromCampaigns(
        account,
        email,
        leftoverPausedOrStopped,
        membership,
        dryRun,
        result,
      );
      if (!dryRun) this.state.clearRestingInbox(email);
      if (added.length || existing || cleared.length) {
        result.restored.push({ email, campaignIds: added });
      }
    }

    if (!dryRun) await this.state.save();

    console.log(
      `[client-rest] onWeek=${result.onWeekCohort} examined=${result.examined} benched=${result.benched.length} restored=${result.restored.length} errors=${result.errors.length}`,
    );

    // D71 — rest movements stay in the log. Slack does not say who is on
    // this fortnight.
    if (result.benched.length || result.restored.length) {
      console.log(
        `[client-rest] slack-quiet onWeek=${result.onWeekCohort} benched=${result.benched.length} restored=${result.restored.length}`,
      );
    }
    return result;
  }

  private onWeekTargets(
    clientId: number | null,
    groupKey: string,
    campaigns: SmartleadCampaign[],
    activeByClient: Map<number, SmartleadCampaign[]>,
  ): number[] {
    const fromClient =
      clientId != null ? (activeByClient.get(clientId) ?? []) : [];
    const fromBcp =
      groupKey === "bcp"
        ? campaigns.filter((campaign) => {
            if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") {
              return false;
            }
            if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) {
              return false;
            }
            return isBcpCampaignName(String(campaign.name ?? ""));
          })
        : [];
    return [...new Set([...fromClient, ...fromBcp].map((campaign) => campaign.id))];
  }

  /** Last-account-on-campaign guard applies to every detach (D43 / D169). */
  private async detachFromCampaigns(
    account: SmartleadAccountWithCampaigns,
    email: string,
    campaignIds: number[],
    membership: Map<number, number>,
    dryRun: boolean,
    result: ClientRestResult,
  ): Promise<number[]> {
    const removed: number[] = [];
    for (const campaignId of campaignIds) {
      const remaining = membership.get(campaignId) ?? 0;
      if (remaining <= 1) {
        result.skipped.push(
          `${email}: last account on #${campaignId} — wait for top-up`,
        );
        continue;
      }
      try {
        if (!dryRun) {
          await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
            account.id,
          ]);
          await sleep(150);
          dropMembership(account, campaignId);
        }
        membership.set(campaignId, remaining - 1);
        removed.push(campaignId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        result.errors.push(`${email} remove #${campaignId}: ${message}`);
      }
    }
    return removed;
  }
}
