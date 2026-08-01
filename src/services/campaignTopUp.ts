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
import type { StateStore } from "../state/store.js";

/**
 * Bring every active campaign up to a minimum sender headcount.
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
  if (!patterns.length) return false;
  const name = String(campaign.name ?? "").toLowerCase();
  const id = String(campaign.id);
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    return p === id || name.includes(p);
  });
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
    const senderCounts = new Map<number, number>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      if (!accountEmail(account)) continue;
      for (const id of campaignIdsOf(account)) {
        senderCounts.set(id, (senderCounts.get(id) ?? 0) + 1);
      }
    }

    const floor = this.config.minCampaignSenders;
    const excluded = this.config.topUpExcludeCampaigns;
    const excludedCampaignIds = new Set(
      (campaigns as SmartleadCampaign[])
        .filter((campaign) => isExcluded(campaign, excluded))
        .map((campaign) => campaign.id),
    );

    // Live counts, decremented as senders are pulled, so a run cannot strip a
    // donor campaign below the floor across several moves.
    const projected = new Map(senderCounts);

    // Where each generic currently sends. A generic with no campaign is free;
    // one on a campaign is reassignable only while that campaign keeps a
    // surplus above the floor.
    const campaignsByEmail = new Map<string, number[]>();
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) campaignsByEmail.set(email, campaignIdsOf(account));
    }

    /** Can this generic be taken without dropping a donor below the floor? */
    const isReassignable = (email: string): boolean => {
      const from = campaignsByEmail.get(email.toLowerCase()) ?? [];
      return from.every((id) => (projected.get(id) ?? 0) - 1 >= floor);
    };

    const needy: Array<{ campaign: SmartleadCampaign; senders: number }> = (campaigns as SmartleadCampaign[])
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .filter((c) => {
        if (isExcluded(c, excluded)) {
          result.skipped.push(`${c.id} ${c.name ?? ""} (excluded)`.trim());
          return false;
        }
        return true;
      })
      .map((c) => ({
        campaign: c,
        senders: senderCounts.get(c.id) ?? 0,
      }))
      .filter((row) => row.senders < floor)
      // Neediest first, so a shallow pool helps the worst campaign.
      .sort((a, b) => a.senders - b.senders);

    // A generic on several campaigns carries only one client's signature, so
    // every other campaign it sends for is using the wrong brand. Release it
    // from those before filling anything — the releases may themselves drop a
    // campaign below the floor, which this run then fills.
    const activeIds = new Set(
      (campaigns as SmartleadCampaign[])
        .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
        .map((c) => c.id),
    );
    for (const row of this.state.listPoolMailboxes()) {
      // A recovery swap is a dedicated one-for-one assignment until the
      // original recovers. Campaign balancing must never steal it.
      if (activeSwapPoolEmails.has(row.email.toLowerCase())) continue;
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

      // Keep the campaign whose client the mailbox is currently branded for;
      // if that is unknowable, keep the one it was most recently assigned to.
      const keep =
        on.find((id) => {
          const c = campaignById.get(id);
          return (
            row.assignedClientId != null &&
            typeof c?.client_id === "number" &&
            c.client_id === row.assignedClientId
          );
        }) ?? on[on.length - 1]!;

      const remaining = new Set(on);
      for (const id of on) {
        if (id === keep) continue;
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
        `[top-up] released ${result.released.length} duplicated sender(s) from campaigns they were not branded for`,
      );
    }

    // Recompute shortfalls against the post-release counts.
    const needyAfter = (campaigns as SmartleadCampaign[])
      .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
      .filter((c) => !isExcluded(c, excluded))
      .map((c) => ({ campaign: c, senders: projected.get(c.id) ?? 0 }))
      .filter((row) => row.senders < floor)
      .sort((a, b) => a.senders - b.senders);
    needy.length = 0;
    needy.push(...needyAfter);

    if (!needy.length) {
      console.log(`[top-up] All active campaigns at or above ${floor} senders`);
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
      const platformOrder: Array<"GOOGLE" | "MICROSOFT"> =
        espCounts.MICROSOFT > espCounts.GOOGLE
          ? ["MICROSOFT", "GOOGLE"]
          : ["GOOGLE", "MICROSOFT"];

      let placed = 0;
      let consecutiveFailures = 0;
      const need = floor - senders;

      // Assigning is two writes per mailbox; a long run trips Smartlead's
      // limiter, so the loop is allowed more attempts than mailboxes needed.
      for (let attempt = 0; placed < need && attempt < need * 2; attempt += 1) {
        // Match the campaign's existing ESP mix where we can; a Google
        // campaign sending through a Microsoft mailbox scores differently.
        const pool = this.state.findReassignablePoolMailbox(
          platformOrder,
          (email) => {
            const key = email.toLowerCase();
            return (
              !activeSwapPoolEmails.has(key) &&
              !selectedThisRun.has(key) &&
              !(campaignsByEmail.get(key) ?? []).includes(campaign.id) &&
              isReassignable(key)
            );
          },
        );
        if (!pool || !pool.smartleadAccountId) break;

        // Where it is coming from, so it can be released rather than shared.
        const donors = (campaignsByEmail.get(pool.email.toLowerCase()) ?? [])
          .filter((id) => id !== campaign.id);

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

              for (const donorId of donors) {
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

          for (const donorId of donors) {
            projected.set(donorId, (projected.get(donorId) ?? 1) - 1);
          }
          projected.set(campaign.id, (projected.get(campaign.id) ?? 0) + 1);
          campaignsByEmail.set(pool.email.toLowerCase(), [campaign.id]);
          selectedThisRun.add(pool.email.toLowerCase());

          if (!dryRun) {
            this.state.upsertPoolMailbox({
              ...pool,
              status: "assigned",
              assignedClientId: clientId,
              assignedClientName: clientName,
              assignedAt: new Date().toISOString(),
            });
          }
          placed += 1;
          result.assigned.push({
            campaignId: campaign.id,
            campaignName: String(campaign.name ?? campaign.id),
            email: pool.email,
            clientName,
            movedFrom: donors,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${pool.email} → ${campaign.id}: ${message}`);
          console.warn(
            `[top-up] ${pool.email} → #${campaign.id}: ${message}`,
          );
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

    if (result.assigned.length || result.unfilled.length) {
      const byCampaign = new Map<string, number>();
      for (const a of result.assigned) {
        const key = `#${a.campaignId} ${a.campaignName}`;
        byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
      }
      try {
        await this.slack.send(
          [
            `${dryRun ? "[DRY RUN] " : ""}Campaign top-up to ${floor} senders:`,
            ...[...byCampaign].map(([name, n]) => `- ${name}: +${n} generic(s)`),
            ...result.unfilled.map(
              (u) => `- #${u.campaignId} ${u.name}: still short ${u.shortBy} (pool exhausted)`,
            ),
          ].join("\n"),
        );
      } catch (error) {
        console.warn("[top-up] Slack notify failed", error);
      }
    }

    return result;
  }
}
