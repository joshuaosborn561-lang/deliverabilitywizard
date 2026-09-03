import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import {
  RETIRE_AFTER_CONSECUTIVE_FAILS,
  judgeDomainCycle,
  nextConsecutiveFails,
  type DomainMailboxReading,
} from "../lib/domainControl.js";
import { domainProof } from "../lib/isolationProof.js";
import { isProtectedOwner } from "../lib/protectedClient.js";
import {
  neutralizeProtectedRetireAsks,
  ownerOfDomain,
  refreshDomainOwnerCache,
  requestRetireOrCover,
} from "../lib/retireAsk.js";
import type { DomainControlHistoryRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";

export class DomainLifecycleService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly slack: SlackClient,
    private readonly book?: InventoryBook,
  ) {}

  async run(): Promise<{
    domains: number;
    buyAhead: number;
    retire: number;
    covered: number;
  }> {
    let accounts: Awaited<ReturnType<InventoryBook["get"]>>["accounts"] = [];
    let clients: Awaited<ReturnType<InventoryBook["get"]>>["clients"] = [];
    if (this.book) {
      const snap = await this.book.get();
      accounts = snap.accounts;
      clients = snap.clients;
      refreshDomainOwnerCache(this.store, accounts, clients, this.config);
      await neutralizeProtectedRetireAsks({
        store: this.store,
        slack: this.slack,
        config: this.config,
        accounts,
        clients,
      });
    }
    const pods = this.store.getIsolation().pods;
    const readings: DomainMailboxReading[] = this.store
      .listMailboxControls()
      .map((row) => {
        const pod = row.podId ? pods[row.podId] : undefined;
        return {
          email: row.email,
          placement: row.placement,
          resting:
            pod?.status === "resting" || pod?.pool === "generic_resting",
          ranAt: row.ranAt,
        };
      });
    return this.afterReadings(readings, { accounts, clients });
  }

  async afterReadings(
    readings: Array<DomainMailboxReading & { ranAt?: string }>,
    inventory?: {
      accounts?: Parameters<typeof ownerOfDomain>[2];
      clients?: Parameters<typeof ownerOfDomain>[3];
    },
  ): Promise<{
    domains: number;
    buyAhead: number;
    retire: number;
    covered: number;
  }> {
    const result = { domains: 0, buyAhead: 0, retire: 0, covered: 0 };
    if (!readings.length) return result;

    const byDomain = new Map<string, Array<DomainMailboxReading & { ranAt?: string }>>();
    for (const row of readings) {
      const domain = row.email.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      const list = byDomain.get(domain) ?? [];
      list.push(row);
      byDomain.set(domain, list);
    }

    for (const [domain, group] of byDomain) {
      result.domains += 1;
      const cycleAt =
        group
          .map((row) => row.ranAt)
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1) ?? new Date().toISOString();
      const prev = this.store.getDomainHistory(domain);
      if (prev?.status === "retired") continue;
      if (prev?.readings.some((point) => point.at === cycleAt)) continue;

      const verdict = judgeDomainCycle(
        domain,
        group,
        this.config.extraGenericDomains,
      );
      const consecutiveFails = nextConsecutiveFails(
        prev?.consecutiveFails ?? 0,
        verdict.domainFailed,
      );
      const owner = ownerOfDomain(
        domain,
        this.store,
        inventory?.accounts,
        inventory?.clients,
        this.config,
      );
      if (owner) this.store.upsertDomainOwner(owner);
      const protectedClient = isProtectedOwner(owner, this.config);
      const history: DomainControlHistoryRecord = {
        domain,
        fleet: verdict.fleet,
        consecutiveFails,
        status:
          consecutiveFails >= RETIRE_AFTER_CONSECUTIVE_FAILS && !protectedClient
            ? "retire_pending"
            : consecutiveFails >= 1
              ? "watch"
              : "ok",
        readings: [
          ...(prev?.readings ?? []),
          {
            at: cycleAt,
            domainFailed: verdict.domainFailed,
            failingEmails: verdict.failingEmails,
            testedEmails: verdict.testedEmails,
          },
        ].slice(-8),
        lastReason: verdict.reason,
      };
      this.store.upsertDomainHistory(history);
      if (!verdict.domainFailed) continue;

      const proof = domainProof(verdict, consecutiveFails);
      const preferRetire =
        consecutiveFails >= RETIRE_AFTER_CONSECUTIVE_FAILS && !protectedClient;
      const asked = await requestRetireOrCover({
        store: this.store,
        slack: this.slack,
        config: this.config,
        domain,
        preferRetire,
        proof,
        owner,
      });
      if (asked.covered) result.covered += 1;
      else if (asked.opened?.kind === "retire_domain") result.retire += 1;
      else if (asked.opened) result.buyAhead += 1;
    }
    await this.store.save();
    return result;
  }
}
