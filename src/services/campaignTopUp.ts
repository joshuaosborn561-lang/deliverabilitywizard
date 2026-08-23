import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { sleep } from "../lib/http.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { isStaffableSender } from "../lib/staffableSender.js";
import type { StateStore } from "../state/store.js";

/**
 * Bring every active (and pending-resume) campaign up to a minimum *staffable*
 * sender headcount — connected + not held / known-spammy (D25).
 *
 * The recovery pool only swaps one-for-one against a benched sender, so a
 * campaign that simply launched thin — or lost senders faster than they were
 * replaced — stays understaffed indefinitely with nothing to correct it.
 *
 * Fill comes from the generic pool only. Client-branded senders are never
 * moved between campaigns: a mailbox on one client's domain sending another
 * client's offer misrepresents both. A generic carries no brand of its own,
 * so its signature and from-name are set to the receiving client on assign.
 */

export interface TopUpAssignment {
  campaignId: number;
  campaignName: string;
  email: string;
  clientName: string;
  /** Campaigns the sender was released from, if it was reassigned. */
  movedFrom: number[];
}

export interface TopUpResult {
  dryRun: boolean;
  assigned: TopUpAssignment[];
  /** Campaigns still short after the pool ran dry, with the remaining gap. */
  unfilled: Array<{ campaignId: number; name: string; shortBy: number }>;
  skipped: string[];
  /** Senders removed from a campaign they were not branded for. */
  released: Array<{ campaignId: number; email: string }>;
  errors: string[];
}

/** Campaign names/ids the operator has excluded from automatic top-up. */
export function isExcluded(
  campaign: { id: number; name?: string | null },
  patterns: string[],
): boolean {
  if (isPodControlShellCampaign(campaign)) return true;
  if (!patterns.length) return false;
  const name = String(campaign.name ?? "").toLowerCase();
  const id = String(campaign.id);
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    return p === id || name.includes(p);
  });
}

/** Prefer the ESP that is short of the mix floor (D43: ~30% each). */
export function espFillOrder(
  counts: { GOOGLE: number; MICROSOFT: number },
  floor: number,
  minPercent: number,
): Array<"GOOGLE" | "MICROSOFT"> {
  const minEsp = Math.ceil((floor * minPercent) / 100);
  const needGoogle = Math.max(0, minEsp - counts.GOOGLE);
  const needMicrosoft = Math.max(0, minEsp - counts.MICROSOFT);
  if (needGoogle > needMicrosoft) return ["GOOGLE", "MICROSOFT"];
  if (needMicrosoft > needGoogle) return ["MICROSOFT", "GOOGLE"];
  return counts.MICROSOFT > counts.GOOGLE
    ? ["MICROSOFT", "GOOGLE"]
    : ["GOOGLE", "MICROSOFT"];
}

/** Consecutive write failures before a campaign is abandoned for this run. */
const MAX_CONSECUTIVE_FAILURES = 3;

export class CampaignTopUpService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<TopUpResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: TopUpResult = {
      dryRun,
      assigned: [],
      unfilled: [],
      skipped: [],
      released: [],
      errors: [],
    };

    if (!this.config.enableCampaignTopUp) {
      console.log("[top-up] Disabled (ENABLE_CAMPAIGN_TOP_UP=false)");
      return result;
    }

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);

    const clientsById = new Map(clients.map((c) => [c.id, c]));
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const accountByEmail = new Map(
      (accounts as SmartleadAccountWithCampaigns[])
        .map((account) => [accountEmail(account)?.toLowerCase(), account] as const)
        .filter(
          (row): row is [string, SmartleadAccountWithCampaigns] =>
            Boolean(row[0]),
        ),
    );
    const activeSwapPoolEmails = new Set(
      this.state
        .listActiveSwaps()
        .map((swap) => swap.poolEmail.toLowerCase()),
    );
    const inboxThreshold = this.config.remediationInboxThreshold;
    const staffableCounts = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email) continue;
      const held = Boolean(this.state.getHeldInbox(email));
      const resting = Boolean(this.state.getRestingInbox(email));
      const heldRate = this.state.getHeldInbox(email)?.inboxRate;
      if (
        !isStaffableSender(account, {
          held,
          resting,
          copyCanary: this.state.isCopyCanary(email),
          inboxRate: heldRate,
          inboxThreshold,
        })
      ) {
        continue;
      }
      for (const id of campaignIdsOf(account)) {
        staffableCounts.set(id, (staffableCounts.get(id) ?? 0) + 1);
      }
    }

    const floor = this.config.minCampaignSenders;
    const excluded = this.config.topUpExcludeCampaigns;
    const excludedCampaignIds = new Set(
      (campaigns as SmartleadCampaign[])
        .filter((campaign) => isExcluded(campaign, excluded))
        .map((campaign) => campaign.id),
    );

    const isManagedCampaign = (c: SmartleadCampaign): boolean => {
      const status = String(c.status ?? "").toUpperCase();
      if (status === "ACTIVE") return true;
      // Protective pauses (last-account remove) stay refillable so health can
      // START them again once the floor is met.
      return status === "PAUSED" && this.state.hasPendingResume(c.id);
    };

    // Live staffable counts, decremented as senders are pulled, so a run cannot
    // strip a donor campaign below the floor across several moves.
    const projected = new Map(staffableCounts);

    // Where each generic currently sends. A generic with no campaign is free;
    // one on a campaign is reassignable only while that campaign keeps a
    // surplus above the floor.
    const campaignsByEmail = new Map<string, number[]>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) campaignsByEmail.set(email, campaignIdsOf(account));
    }

    const sameClient = (
      a: SmartleadCampaign | undefined,
      b: SmartleadCampaign | undefined,
    ): boolean =>
      typeof a?.client_id === "number" &&
      typeof b?.client_id === "number" &&
      a.client_id === b.client_id;

    /**
     * Can this generic cover the target? Same-client donors keep the mailbox
     * (D26 fan-out). Cross-client donors must stay at/above the floor after a
     * real move.
     */
    const isReassignable = (
      email: string,
      target: SmartleadCampaign,
    ): boolean => {
      const from = campaignsByEmail.get(email.toLowerCase()) ?? [];
      return from.every((id) => {
        if (sameClient(campaignById.get(id), target)) return true;
        return (projected.get(id) ?? 0) - 1 >= floor;
      });
    };

    const needy: Array<{ campaign: SmartleadCampaign; senders: number }> = (campaigns as SmartleadCampaign[])
      .filter((c) => isManagedCampaign(c))
      .filter((c) => {
        if (isExcluded(c, excluded)) {
          result.skipped.push(`${c.id} ${c.name ?? ""} (excluded)`.trim());
          return false;
        }
        return true;
      })
      .map((c) => ({
        campaign: c,
        senders: staffableCounts.get(c.id) ?? 0,
      }))
      .filter((row) => row.senders < floor)
      // Neediest first, so a shallow pool helps the worst campaign.
      .sort((a, b) => a.senders - b.senders);

    // D26: same-client multi-campaign membership is allowed. Only release a
    // generic from a campaign when that campaign belongs to a *different*
    // client than the one the mailbox is branded for.
    const activeIds = new Set(
      (campaigns as SmartleadCampaign[])
        .filter((c) => isManagedCampaign(c))
        .map((c) => c.id),
    );
    for (const row of this.state.listPoolMailboxes()) {
      // A recovery swap is a dedicated one-for-one assignment until the
      // original recovers. Campaign balancing must never steal it.
      if (activeSwapPoolEmails.has(row.email.toLowerCase())) continue;
      if (this.state.getRestingInbox(row.email)) continue;
      const on = (campaignsByEmail.get(row.email.toLowerCase()) ?? []).filter(
        (id) => activeIds.has(id),
      );
      if (on.length < 2 || !row.smartleadAccountId) continue;
      // Exclusions mean "do not mutate this campaign", including cleanup.
      if (on.some((id) => excludedCampaignIds.has(id))) {
        result.skipped.push(
          `${row.email} duplicate cleanup (serves excluded campaign)`,
        );
        continue;
      }

      const keep =
        on.find((id) => {
          const c = campaignById.get(id);
          return (
            row.assignedClientId != null &&
            typeof c?.client_id === "number" &&
            c.client_id === row.assignedClientId
          );
        }) ?? on[on.length - 1]!;
      const keepCampaign = campaignById.get(keep);

      const remaining = new Set(on);
      for (const id of on) {
        if (id === keep) continue;
        if (sameClient(campaignById.get(id), keepCampaign)) continue;
        try {
          if (!dryRun) {
            await this.smartlead.removeEmailAccountsFromCampaign(id, [
              row.smartleadAccountId,
            ]);
            await sleep(250);
          }
          projected.set(id, (projected.get(id) ?? 1) - 1);
          remaining.delete(id);
          result.released.push({ campaignId: id, email: row.email });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`release ${row.email} from ${id}: ${message}`);
        }
      }
      campaignsByEmail.set(row.email.toLowerCase(), [...remaining]);
    }
    if (result.released.length) {
      console.log(
        `[top-up] released ${result.released.length} sender(s) from other-client campaigns`,
      );
    }

    // Recompute shortfalls against the post-release counts.
    const needyAfter = (campaigns as SmartleadCampaign[])
      .filter((c) => isManagedCampaign(c))
      .filter((c) => !isExcluded(c, excluded))
      .map((c) => ({ campaign: c, senders: projected.get(c.id) ?? 0 }))
      .filter((row) => row.senders < floor)
      .sort((a, b) => a.senders - b.senders);
    needy.length = 0;
    needy.push(...needyAfter);

    if (!needy.length) {
      console.log(
        `[top-up] All managed campaigns at or above ${floor} staffable senders`,
      );
      return result;
    }

    const selectedThisRun = new Set<string>();
    for (const { campaign, senders } of needy) {
      const clientId =
        typeof campaign.client_id === "number" ? campaign.client_id : null;
      const clientName = clientId
        ? clientDisplayName(clientsById.get(clientId) ?? { id: clientId })
        : "Unassigned / Agency";
      const brand =
        clientName.replace(/\s*\(.*?\)\s*$/, "").trim() || clientName;
      const espCounts = { GOOGLE: 0, MICROSOFT: 0 };
      for (const account of accounts as SmartleadAccountWithCampaigns[]) {
        if (!campaignIdsOf(account).includes(campaign.id)) continue;
        const platform = poolEspFromSmartleadType(account.type);
        if (platform) espCounts[platform] += 1;
      }

      let placed = 0;
      let consecutiveFailures = 0;
      const need = floor - senders;

      // Assigning is two writes per mailbox; a long run trips Smartlead's
      // limiter, so the loop is allowed more attempts than mailboxes needed.
      for (let attempt = 0; placed < need && attempt < need * 2; attempt += 1) {
        const platformOrder = espFillOrder(
          espCounts,
          floor,
          this.config.campaignEspMixMinPercent,
        );
        const pool = this.state.findReassignablePoolMailbox(
          platformOrder,
          (email) => {
            const key = email.toLowerCase();
            return (
              !activeSwapPoolEmails.has(key) &&
              !selectedThisRun.has(key) &&
              !(campaignsByEmail.get(key) ?? []).includes(campaign.id) &&
              isReassignable(key, campaign)
            );
          },
        );
        if (!pool || !pool.smartleadAccountId) break;

        // Cross-client donors are moved off; same-client donors keep the
        // mailbox (D26 — one client, many campaigns).
        const donors = (campaignsByEmail.get(pool.email.toLowerCase()) ?? [])
          .filter((id) => id !== campaign.id);
        const crossClientDonors = donors.filter(
          (id) => !sameClient(campaignById.get(id), campaign),
        );

        const firstName = pool.firstName || "Pool";
        const lastName = pool.lastName || "User";

        try {
          const original = accountByEmail.get(pool.email.toLowerCase());
          if (!original) {
            throw new Error(
              `${pool.email} is in pool state but missing from Smartlead inventory`,
            );
          }
          const removedDonors: number[] = [];
          let targetAdded = false;
          let identityAttempted = false;
          if (!dryRun) {
            try {
              // Add first. If this fails, the donor is untouched. Subsequent
              // failures are compensated below so the mailbox cannot be
              // stranded between campaigns.
              await this.smartlead.addEmailAccountsToCampaign(campaign.id, [
                pool.smartleadAccountId,
              ]);
              targetAdded = true;
              await sleep(250);

              for (const donorId of crossClientDonors) {
                await this.smartlead.removeEmailAccountsFromCampaign(donorId, [
                  pool.smartleadAccountId,
                ]);
                removedDonors.push(donorId);
                await sleep(250);
              }

              identityAttempted = true;
              await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
                signature: buildPoolSignature({
                  firstName,
                  lastName,
                  clientBrand: brand,
                }),
                from_name: `${firstName} ${lastName}`,
                client_id: clientId,
                // D30/D24: never leave a moved mailbox on blank gap / wrong cap.
                time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
                max_email_per_day: this.config.messagePerDay,
              });
              await sleep(200);
            } catch (moveError) {
              const rollbackErrors: string[] = [];
              if (targetAdded) {
                try {
                  await this.smartlead.removeEmailAccountsFromCampaign(
                    campaign.id,
                    [pool.smartleadAccountId],
                  );
                } catch (error) {
                  rollbackErrors.push(
                    `remove target: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              for (const donorId of removedDonors) {
                try {
                  await this.smartlead.addEmailAccountsToCampaign(donorId, [
                    pool.smartleadAccountId,
                  ]);
                } catch (error) {
                  rollbackErrors.push(
                    `restore donor ${donorId}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              if (identityAttempted && original) {
                try {
                  await this.smartlead.updateEmailAccount(
                    pool.smartleadAccountId,
                    {
                      signature: original.signature ?? "",
                      from_name:
                        original.from_name ?? `${firstName} ${lastName}`,
                      client_id: original.client_id ?? null,
                    },
                  );
                } catch (error) {
                  rollbackErrors.push(
                    `restore identity: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              if (rollbackErrors.length) {
                throw new Error(
                  `${moveError instanceof Error ? moveError.message : String(moveError)}; rollback incomplete: ${rollbackErrors.join("; ")}`,
                );
              }
              throw moveError;
            }
          }

          for (const donorId of crossClientDonors) {
            projected.set(donorId, (projected.get(donorId) ?? 1) - 1);
          }
          projected.set(campaign.id, (projected.get(campaign.id) ?? 0) + 1);
          const kept = donors.filter((id) =>
            sameClient(campaignById.get(id), campaign),
          );
          campaignsByEmail.set(pool.email.toLowerCase(), [
            ...new Set([campaign.id, ...kept]),
          ]);
          selectedThisRun.add(pool.email.toLowerCase());

          if (!dryRun) {
            this.state.upsertPoolMailbox({
              ...pool,
              status: "assigned",
              assignedClientId: clientId,
              assignedClientName: clientName,
              // D43 — first live assign starts the sit clock. Same-client
              // fan-out / top-up must not refresh it or 300 generics never sit.
              assignedAt: pool.assignedAt ?? new Date().toISOString(),
            });
          }
          placed += 1;
          if (pool.platform === "GOOGLE" || pool.platform === "MICROSOFT") {
            espCounts[pool.platform] += 1;
          }
          result.assigned.push({
            campaignId: campaign.id,
            campaignName: String(campaign.name ?? campaign.id),
            email: pool.email,
            clientName,
            movedFrom: crossClientDonors,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${pool.email} → ${campaign.id}: ${message}`);
          console.warn(
            `[top-up] ${pool.email} → #${campaign.id}: ${message}`,
          );
          // If compensation itself failed, Smartlead's live membership is
          // uncertain. Quarantine this mailbox for the remainder of the run
          // instead of repeatedly mutating the same partial state.
          if (/rollback incomplete/i.test(message)) {
            selectedThisRun.add(pool.email.toLowerCase());
          }
          consecutiveFailures += 1;
          // One failure is usually a rate limit or a transient 5xx, and
          // abandoning the campaign over it leaves it short until the next
          // cron. Back off and keep going; give up only once the failures
          // look systemic rather than incidental.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.warn(
              `[top-up] #${campaign.id}: ${consecutiveFailures} consecutive failures — stopping this campaign`,
            );
            break;
          }
          await sleep(2000 * consecutiveFailures);
          continue;
        }
        consecutiveFailures = 0;
      }

      if (placed < need) {
        result.unfilled.push({
          campaignId: campaign.id,
          name: String(campaign.name ?? campaign.id),
          shortBy: need - placed,
        });
      }
      console.log(
        `[top-up] #${campaign.id} ${campaign.name} — ${senders} → ${senders + placed} (needed ${need}, placed ${placed})`,
      );
    }

    if (!dryRun) await this.state.save();

    console.log(
      `[top-up] ${result.assigned.length} generic(s) assigned; ${result.unfilled.length} campaign(s) still short; ${result.errors.length} error(s)`,
    );
    // The count alone is not diagnosable; a failing run has to say why.
    for (const e of result.errors.slice(0, 10)) {
      console.log(`[top-up]   error: ${e}`);
    }

    // Slack is owned by CampaignHealthService so shortfalls / resumes share
    // one staffing alert. Top-up still logs locally for Railway diagnostics.

    return result;
  }
}
