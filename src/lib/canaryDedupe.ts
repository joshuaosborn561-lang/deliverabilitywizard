import {
  isAutomatedTest,
  isTestStoppable,
  testIdOf,
} from "../clients/smartdelivery.js";
import type { SpamTestSummary } from "../types/index.js";
import { campaignIdFromCanaryTestName } from "./isolationNames.js";

/**
 * D309 — one live "Canary copy" SmartDelivery test per campaign.
 *
 * Overlapping attach runs (a stale-takeover pass racing the new one) and
 * ambiguous create failures (HTTP 429 after the POST landed) each created
 * a second, third, fourth test for the same campaign. This module holds
 * the two guards: a create ledger (single-flight + cooldown) and a pure
 * planner that picks the one test to keep and the extras to STOP.
 */

/** No second create for a campaign within this window of a create or a failed create. */
export const CANARY_CREATE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
/** Most extras stopped per attach pass, so cleanup never floods SmartDelivery. */
export const CANARY_DEDUPE_MAX_STOPS = 120;

export class CanaryCreateLedger {
  private readonly inFlight = new Map<number, Promise<string | undefined>>();
  private readonly created = new Map<number, { testId?: string; at: number }>();

  /** Run `fn` once per campaign at a time; concurrent callers share its result. */
  singleFlight(
    campaignId: number,
    fn: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const running = this.inFlight.get(campaignId);
    if (running) return running;
    const p = fn().finally(() => {
      this.inFlight.delete(campaignId);
    });
    this.inFlight.set(campaignId, p);
    return p;
  }

  /** A create was attempted: block another one until the cooldown passes. */
  markAttempt(campaignId: number, now = Date.now()): void {
    this.created.set(campaignId, { at: now });
  }

  markCreated(campaignId: number, testId: string, now = Date.now()): void {
    this.created.set(campaignId, { testId, at: now });
  }

  /** The entry for a recent create or attempt, if still inside the cooldown. */
  recent(
    campaignId: number,
    now = Date.now(),
  ): { testId?: string; at: number } | undefined {
    const row = this.created.get(campaignId);
    if (!row) return undefined;
    if (now - row.at >= CANARY_CREATE_COOLDOWN_MS) {
      this.created.delete(campaignId);
      return undefined;
    }
    return row;
  }

  clear(): void {
    this.inFlight.clear();
    this.created.clear();
  }
}

/** Process-wide ledger: every CopyCanaryService shares it. */
export const canaryCreateLedger = new CanaryCreateLedger();

export interface CanaryDuplicatePlan {
  /** campaignId -> test id to keep. */
  keep: Map<number, string>;
  /** Extra living tests to stop (never delete). */
  stop: Array<{ campaignId: number; testId: string }>;
}

function hasReadings(test: SpamTestSummary): boolean {
  const runs = Number(test.current_test_run_no ?? test.test_run_no ?? 0);
  const counted =
    Number(test.inbox_count ?? 0) +
    Number(test.tab_count ?? 0) +
    Number(test.spam_count ?? 0);
  return runs > 0 || counted > 0;
}

function recency(test: SpamTestSummary): number {
  const t = Date.parse(String(test.created_at ?? test.schedule_start_time ?? ""));
  if (Number.isFinite(t)) return t;
  const id = Number(testIdOf(test));
  return Number.isFinite(id) ? id : 0;
}

/**
 * For each campaign with more than one living Canary copy test, keep the
 * stored test when it is still living, else the newest with readings (then
 * the newest), and list the rest to stop.
 */
export function planCanaryDuplicates(
  tests: SpamTestSummary[],
  storedTestIds: ReadonlyMap<number, string | undefined> = new Map(),
): CanaryDuplicatePlan {
  const byCampaign = new Map<number, SpamTestSummary[]>();
  for (const test of tests) {
    if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
    const campaignId = campaignIdFromCanaryTestName(test.test_name);
    if (campaignId === undefined || !testIdOf(test)) continue;
    const list = byCampaign.get(campaignId) ?? [];
    list.push(test);
    byCampaign.set(campaignId, list);
  }
  const plan: CanaryDuplicatePlan = { keep: new Map(), stop: [] };
  for (const [campaignId, group] of byCampaign) {
    const stored = storedTestIds.get(campaignId);
    const ranked = [...group].sort((a, b) => {
      const readA = hasReadings(a) ? 1 : 0;
      const readB = hasReadings(b) ? 1 : 0;
      if (readA !== readB) return readB - readA;
      const storedA = stored && testIdOf(a) === stored ? 1 : 0;
      const storedB = stored && testIdOf(b) === stored ? 1 : 0;
      if (storedA !== storedB) return storedB - storedA;
      return recency(b) - recency(a);
    });
    const [winner, ...extras] = ranked;
    plan.keep.set(campaignId, testIdOf(winner)!);
    for (const extra of extras) {
      plan.stop.push({ campaignId, testId: testIdOf(extra)! });
    }
  }
  return plan;
}
