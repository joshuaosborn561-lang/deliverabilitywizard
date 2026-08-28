import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import {
  RETIRE_AFTER_CONSECUTIVE_FAILS,
  judgeDomainCycle,
  nextConsecutiveFails,
  type DomainMailboxReading,
} from "../lib/domainControl.js";
import { domainProof } from "../lib/isolationProof.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import type { DomainControlHistoryRecord } from "../state/isolationState.js";
import type { StateStore } from "../state/store.js";

export class DomainLifecycleService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly slack: SlackClient,
  ) {}

  async run(): Promise<{
    domains: number;
    buyAhead: number;
    retire: number;
  }> {
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
    return this.afterReadings(readings);
  }

  async afterReadings(
    readings: Array<DomainMailboxReading & { ranAt?: string }>,
  ): Promise<{ domains: number; buyAhead: number; retire: number }> {
    const result = { domains: 0, buyAhead: 0, retire: 0 };
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
      const history: DomainControlHistoryRecord = {
        domain,
        fleet: verdict.fleet,
        consecutiveFails,
        status: consecutiveFails >= RETIRE_AFTER_CONSECUTIVE_FAILS
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
      if (consecutiveFails >= RETIRE_AFTER_CONSECUTIVE_FAILS) {
        const opened = await requestIsolationAction({
          store: this.store,
          slack: this.slack,
          action: buildIsolationAction({
            kind: "retire_domain",
            title: `Retire ${domain}`,
            proof,
            detail: {
              domain,
              // D150 — the retire tap is also the replacement buy + ESP match
              // + D134 backfill. Quantity/parent ride along so execute has them.
              quantity: 1,
              parentDomain: this.config.isolationBuyParentDomain,
            },
          }),
        });
        if (opened) result.retire += 1;
      } else if (consecutiveFails >= 1) {
        const opened = await requestIsolationAction({
          store: this.store,
          slack: this.slack,
          action: buildIsolationAction({
            kind: "buy_domains",
            title: `Buy a replacement for ${domain}`,
            proof,
            detail: {
              domain,
              quantity: 1,
              parentDomain: this.config.isolationBuyParentDomain,
            },
          }),
        });
        if (opened) result.buyAhead += 1;
      }
    }
    await this.store.save();
    return result;
  }
}
