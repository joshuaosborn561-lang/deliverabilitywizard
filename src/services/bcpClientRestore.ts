import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountDomain,
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  testIdOf,
} from "../clients/smartdelivery.js";
import {
  diagnoseBlacklists,
  domainsSafeToReplace,
  filterTeardownBlacklistHits,
} from "../lib/blacklistDiagnosis.js";
import { sleep } from "../lib/http.js";
import { parsePersonName } from "../lib/poolSignature.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import type { StateStore } from "../state/store.js";
import { isPrewarmedGeneric } from "./warmupGate.js";

export interface BcpRestoreResult {
  dryRun: boolean;
  bcpCampaignIds: number[];
  burnedDomains: string[];
  genericsRemoved: Array<{
    email: string;
    accountId: number;
    campaignIds: number[];
  }>;
  originalsRestored: Array<{
    email: string;
    accountId: number;
    campaignIds: number[];
    domain: string;
  }>;
  originalsSkippedBurned: Array<{ email: string; domain: string }>;
  idleAttached: Array<{
    email: string;
    accountId: number;
    campaignId: number;
    domain: string;
  }>;
  holdsCleared: number;
  swapsCleared: number;
  errors: string[];
}

/**
 * Owner override for day-one BCP: pull crossscale generics off BCP campaigns,
 * restore held BCP-domain originals that are not domain-burned, clear holds /
 * swaps, and top up any shortfall from idle non-blacklisted BCP domains only.
 */
export class BcpClientRestoreService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(options: { dryRun?: boolean } = {}): Promise<BcpRestoreResult> {
    const dryRun = options.dryRun ?? this.config.dryRun;
    const result: BcpRestoreResult = {
      dryRun,
      bcpCampaignIds: [],
      burnedDomains: [],
      genericsRemoved: [],
      originalsRestored: [],
      originalsSkippedBurned: [],
      idleAttached: [],
      holdsCleared: 0,
      swapsCleared: 0,
      errors: [],
    };

    console.log(
      `[bcp-restore] Starting (${dryRun ? "DRY RUN" : "LIVE"}) — pull generics, restore BCP domains`,
    );

    const campaigns = await this.smartlead.listCampaigns();
    const bcpCampaigns = campaigns.filter((c) =>
      isBcpCampaignName(String(c.name ?? "")),
    );
    const bcpIds = new Set(bcpCampaigns.map((c) => c.id));
    result.bcpCampaignIds = [...bcpIds];

    if (!bcpIds.size) {
      result.errors.push("No BCP campaigns found");
      return result;
    }

    result.burnedDomains = await this.loadBurnedDomains(bcpIds);
    const burned = new Set(result.burnedDomains.map((d) => d.toLowerCase()));

    const accounts = await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: true,
    });
    const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) byEmail.set(email, account);
    }

    // 1) Reverse every active swap that put a generic onto BCP campaigns.
    const bcpSwaps = this.state
      .listActiveSwaps()
      .filter((swap) => swap.campaignIds.some((id) => bcpIds.has(id)));

    for (const swap of bcpSwaps) {
      const bcpCampaignIds = swap.campaignIds.filter((id) => bcpIds.has(id));
      const originalDomain = swap.originalEmail.split("@")[1]?.toLowerCase() ?? "";
      const burnedOriginal = burned.has(originalDomain);

      try {
        if (!dryRun) {
          for (const campaignId of bcpCampaignIds) {
            try {
              await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
                swap.poolAccountId,
              ]);
              await sleep(250);
            } catch (error) {
              result.errors.push(
                `remove ${swap.poolEmail} from ${campaignId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
        result.genericsRemoved.push({
          email: swap.poolEmail,
          accountId: swap.poolAccountId,
          campaignIds: bcpCampaignIds,
        });

        if (burnedOriginal) {
          result.originalsSkippedBurned.push({
            email: swap.originalEmail,
            domain: originalDomain,
          });
        } else if (isBcpOwnedDomain(originalDomain)) {
          if (!dryRun) {
            for (const campaignId of bcpCampaignIds) {
              try {
                await this.smartlead.addEmailAccountsToCampaign(campaignId, [
                  swap.originalAccountId,
                ]);
                await sleep(250);
              } catch (error) {
                result.errors.push(
                  `reattach ${swap.originalEmail} → ${campaignId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            }
            await this.clearHoldTags(swap.originalAccountId, result);
          }
          result.originalsRestored.push({
            email: swap.originalEmail,
            accountId: swap.originalAccountId,
            campaignIds: bcpCampaignIds,
            domain: originalDomain,
          });
        }

        if (!dryRun) {
          await this.clearPoolBrand(swap.poolAccountId, swap.poolEmail, byEmail);
          this.state.clearSwap(swap.originalEmail);
          this.state.clearHeldInbox(swap.originalEmail);
          this.state.clearInboxRemediation(swap.originalEmail);
          result.swapsCleared += 1;
          result.holdsCleared += 1;
        } else {
          result.swapsCleared += 1;
          result.holdsCleared += 1;
        }
      } catch (error) {
        result.errors.push(
          `swap ${swap.originalEmail}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 2) Sweep any leftover EXTRA_GENERIC / pool mailboxes still on BCP.
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || !account.id) continue;
      const onBcp = campaignIdsOf(account).filter((id) => bcpIds.has(id));
      if (!onBcp.length) continue;
      if (!isPrewarmedGeneric(account, email, this.config, this.state)) continue;
      // Already counted via swap path?
      if (result.genericsRemoved.some((g) => g.email === email)) continue;

      if (!dryRun) {
        for (const campaignId of onBcp) {
          try {
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            await sleep(250);
          } catch (error) {
            result.errors.push(
              `sweep ${email} from ${campaignId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        const pool = this.state.getPoolMailbox(email);
        if (pool) {
          this.state.upsertPoolMailbox({
            ...pool,
            status: "available",
            assignedToEmail: undefined,
            assignedClientId: undefined,
            assignedClientName: undefined,
            assignedAt: undefined,
          });
        }
        await this.clearPoolBrand(account.id, email, byEmail);
      }
      result.genericsRemoved.push({
        email,
        accountId: account.id,
        campaignIds: onBcp,
      });
    }

    // 3) Restore other held BCP-domain originals (no swap row) if not burned.
    for (const held of this.state.listHeldInboxes()) {
      const domain = held.email.split("@")[1]?.toLowerCase() ?? "";
      if (!isBcpOwnedDomain(domain)) continue;
      if (this.state.getSwap(held.email)) continue; // handled above
      const targets = (held.removedFromCampaigns ?? []).filter((id) =>
        bcpIds.has(id),
      );
      if (!targets.length) continue;
      if (burned.has(domain)) {
        result.originalsSkippedBurned.push({
          email: held.email,
          domain,
        });
        continue;
      }
      if (!dryRun) {
        for (const campaignId of targets) {
          try {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [
              held.accountId,
            ]);
            await sleep(250);
          } catch (error) {
            result.errors.push(
              `held reattach ${held.email} → ${campaignId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        await this.clearHoldTags(held.accountId, result);
        this.state.clearHeldInbox(held.email);
        this.state.clearInboxRemediation(held.email);
        result.holdsCleared += 1;
      } else {
        result.holdsCleared += 1;
      }
      result.originalsRestored.push({
        email: held.email,
        accountId: held.accountId,
        campaignIds: targets,
        domain,
      });
    }

    // 4) Fill any BCP campaign still under the floor from idle BCP domains.
    await this.fillFromIdleBcpDomains({
      dryRun,
      bcpIds,
      burned,
      accounts,
      result,
    });

    if (!dryRun) await this.state.save();

    console.log("[bcp-restore] Done", {
      dryRun,
      genericsRemoved: result.genericsRemoved.length,
      originalsRestored: result.originalsRestored.length,
      skippedBurned: result.originalsSkippedBurned.length,
      idleAttached: result.idleAttached.length,
      burnedDomains: result.burnedDomains,
      errors: result.errors.length,
    });

    await this.slack
      .send(
        [
          `*BCP client-domain restore* (${dryRun ? "DRY RUN" : "LIVE"})`,
          `Pulled ${result.genericsRemoved.length} generic placement(s); restored ${result.originalsRestored.length} BCP-domain mailbox(es).`,
          result.originalsSkippedBurned.length
            ? `Skipped burned domain(s): ${[
                ...new Set(result.originalsSkippedBurned.map((s) => s.domain)),
              ].join(", ")}`
            : undefined,
          result.idleAttached.length
            ? `Attached ${result.idleAttached.length} idle BCP mailbox(es) to cover the floor.`
            : undefined,
          result.errors.length
            ? `Errors: ${result.errors.slice(0, 8).join(" | ")}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .catch((error) => {
        console.error("[bcp-restore] Slack notify failed", error);
      });

    return result;
  }

  private async loadBurnedDomains(bcpIds: Set<number>): Promise<string[]> {
    const burned = new Set<string>();
    try {
      const listed = normalizeTestList(await this.smartDelivery.listTests({}));
      const enriched = await this.smartDelivery.enrichCampaignIds(listed);
      const testIds: string[] = [];
      for (const test of enriched) {
        if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
        const cid = campaignIdOf(test);
        if (!cid || !bcpIds.has(Number(cid))) continue;
        const tid = testIdOf(test);
        if (tid) testIds.push(tid);
      }
      const hits = [];
      for (const testId of testIds.slice(0, 40)) {
        try {
          const [domainRaw, ipRaw] = await Promise.all([
            this.smartDelivery.getDomainBlacklist(testId).catch(() => []),
            this.smartDelivery.getIpBlacklist(testId).catch(() => []),
          ]);
          hits.push(
            ...parseDomainBlacklistHits(domainRaw),
            ...parseIpBlacklistHits(ipRaw),
          );
          await sleep(150);
        } catch {
          /* ignore single-test failures */
        }
      }
      for (const domain of domainsSafeToReplace(
        diagnoseBlacklists(filterTeardownBlacklistHits(hits)),
      )) {
        burned.add(domain.toLowerCase());
      }
    } catch (error) {
      console.warn(
        "[bcp-restore] blacklist lookup failed",
        error instanceof Error ? error.message : error,
      );
    }
    return [...burned].sort();
  }

  private async clearHoldTags(
    accountId: number,
    result: BcpRestoreResult,
  ): Promise<void> {
    try {
      const account = await this.smartlead.getEmailAccount(accountId);
      const tagIds = new Set<number>();
      for (const t of account.tags ?? []) {
        const id = t.tag_id ?? t.id;
        const name = t.tag_name ?? t.name ?? "";
        if (typeof id === "number" && /^HOLD-UNTIL-/i.test(name)) {
          tagIds.add(id);
        }
      }
      if (tagIds.size) {
        await this.smartlead.removeTags([accountId], [...tagIds]);
        await sleep(200);
      }
    } catch (error) {
      result.errors.push(
        `clear hold tags ${accountId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async clearPoolBrand(
    accountId: number,
    email: string,
    byEmail: Map<string, SmartleadAccountWithCampaigns>,
  ): Promise<void> {
    try {
      const poolMeta = this.state.getPoolMailbox(email);
      const poolAcc = byEmail.get(email.toLowerCase());
      const { firstName, lastName } = parsePersonName(
        poolAcc?.from_name ||
          (poolMeta ? `${poolMeta.firstName} ${poolMeta.lastName}` : undefined),
      );
      await this.smartlead.updateEmailAccount(accountId, {
        signature: `${firstName} ${lastName}`,
        from_name: `${firstName} ${lastName}`,
      });
      await sleep(150);
    } catch {
      /* non-fatal */
    }
  }

  private async fillFromIdleBcpDomains(input: {
    dryRun: boolean;
    bcpIds: Set<number>;
    burned: Set<string>;
    accounts: SmartleadAccountWithCampaigns[];
    result: BcpRestoreResult;
  }): Promise<void> {
    const floor = this.config.minCampaignSenders;
    // Refresh campaign membership after mutations by recounting from the
    // accounts snapshot, then applying removals/restores from this run.
    const counts = new Map<number, number>();
    for (const id of input.bcpIds) counts.set(id, 0);

    const removed = new Set(
      input.result.genericsRemoved.flatMap((g) =>
        g.campaignIds.map((cid) => `${g.accountId}:${cid}`),
      ),
    );
    const added = new Set(
      input.result.originalsRestored.flatMap((o) =>
        o.campaignIds.map((cid) => `${o.accountId}:${cid}`),
      ),
    );

    for (const account of input.accounts) {
      if (!account.id) continue;
      for (const cid of campaignIdsOf(account)) {
        if (!input.bcpIds.has(cid)) continue;
        if (removed.has(`${account.id}:${cid}`)) continue;
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
      }
    }
    for (const key of added) {
      const [accountId, cidStr] = key.split(":");
      void accountId;
      const cid = Number(cidStr);
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const idle = input.accounts.filter((account) => {
      const email = accountEmail(account)?.toLowerCase();
      const domain = accountDomain(account);
      if (!email || !domain || !account.id) return false;
      if (!isBcpOwnedDomain(domain)) return false;
      if (input.burned.has(domain.toLowerCase())) return false;
      if (isPrewarmedGeneric(account, email, this.config, this.state)) {
        return false;
      }
      // Idle = not on any campaign after this restore (or only removed).
      const remaining = campaignIdsOf(account).filter((cid) => {
        if (removed.has(`${account.id}:${cid}`)) return false;
        return true;
      });
      // Newly restored originals are not idle.
      if (
        input.result.originalsRestored.some(
          (o) => o.accountId === account.id,
        )
      ) {
        return false;
      }
      return remaining.length === 0;
    });

    let idleIdx = 0;
    for (const campaignId of [...input.bcpIds].sort()) {
      let have = counts.get(campaignId) ?? 0;
      while (have < floor && idleIdx < idle.length) {
        const account = idle[idleIdx++]!;
        const email = accountEmail(account)!.toLowerCase();
        const domain = accountDomain(account)!;
        if (!input.dryRun) {
          try {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [
              account.id!,
            ]);
            await sleep(250);
            // If it was held, clear that too.
            if (this.state.getHeldInbox(email)) {
              await this.clearHoldTags(account.id!, input.result);
              this.state.clearHeldInbox(email);
              this.state.clearInboxRemediation(email);
              input.result.holdsCleared += 1;
            }
          } catch (error) {
            input.result.errors.push(
              `idle attach ${email} → ${campaignId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
        }
        input.result.idleAttached.push({
          email,
          accountId: account.id!,
          campaignId,
          domain,
        });
        have += 1;
        counts.set(campaignId, have);
      }
    }
  }
}
