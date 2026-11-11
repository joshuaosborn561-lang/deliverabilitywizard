/**
 * D335 — Sunday-only placement test path. OFF unless
 * `SUNDAY_PLACEMENT_TEST_ENABLED=true` (pending Josh's approval).
 *
 * When on, it runs only on Sundays 06:00–19:59 America/Chicago and creates
 * at most `maxTests` manual placement tests (one per sg-owner, mailboxes
 * from the newest D334 snapshot, flagged mailboxes first), reusing the
 * existing `createManualPlacement` client call with off-campaign senders —
 * no canary shell, no campaign attach, no finding, no Slack, no state.
 * SmartDelivery is the only external dependency and it is typed to the
 * two calls it needs.
 */
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import { defaultControlTemplate } from "../lib/controlTemplate.js";
import { controlSequence, isolationManualPayload } from "../lib/isolationPlacement.js";
import {
  SUNDAY_PLACEMENT_TEST_PREFIX,
  sundayPlacementGate,
  type SundayPlacementConfig,
} from "../lib/sundayPlacement.js";
import type { MailboxHealthRow } from "../lib/mailboxHealthDaily.js";
import type { MailboxHealthStore } from "../state/mailboxHealthStore.js";

type SmartDelivery = Pick<SmartDeliveryClient, "createManualPlacement" | "resolveProviderIds">;

export interface SundayPlacementDeps {
  smartDelivery: SmartDelivery | null;
  store: Pick<MailboxHealthStore, "latest">;
  config: SundayPlacementConfig;
  providerIds: number[];
  /** D333 master kill switch, once it is on this branch. Absent = not wired. */
  masterSwitch?: () => boolean;
  dryRun?: boolean;
  now?: () => Date;
}

export interface SundayPlacementResult {
  ran: boolean;
  created: Array<{ owner: string; testId: string; senders: number }>;
  skipped: string[];
  errors: string[];
}

/** One sender list per owner: flagged mailboxes first, then most sent. */
export function sundaySenderPlan(
  rows: MailboxHealthRow[],
  flagged: Set<string>,
  maxTests: number,
  maxSenders: number,
): Array<{ owner: string; senders: string[] }> {
  const byOwner = new Map<string, MailboxHealthRow[]>();
  for (const r of rows) {
    const owner = r.owner ?? "pool";
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), r]);
  }
  const rank = (r: MailboxHealthRow) => (flagged.has(r.email) ? 1 : 0);
  return [...byOwner.entries()]
    .map(([owner, list]) => ({
      owner,
      flagged: list.filter((r) => flagged.has(r.email)).length,
      sent: list.reduce((a, r) => a + (r.sent ?? 0), 0),
      senders: [...list]
        .sort((a, b) => rank(b) - rank(a) || (b.sent ?? 0) - (a.sent ?? 0) || a.email.localeCompare(b.email))
        .slice(0, maxSenders)
        .map((r) => r.email),
    }))
    .sort((a, b) => b.flagged - a.flagged || b.sent - a.sent || a.owner.localeCompare(b.owner))
    .slice(0, maxTests)
    .map(({ owner, senders }) => ({ owner, senders }));
}

export class SundayPlacementService {
  constructor(private readonly deps: SundayPlacementDeps) {}

  async run(): Promise<SundayPlacementResult> {
    const { config, smartDelivery } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const result: SundayPlacementResult = { ran: false, created: [], skipped: [], errors: [] };
    const refused = sundayPlacementGate(config, now, this.deps.masterSwitch);
    if (refused) {
      result.skipped.push(refused);
      return result;
    }
    if (!smartDelivery) {
      result.errors.push("SmartDelivery is not configured");
      return result;
    }
    const latest = await this.deps.store.latest();
    if (!latest) {
      result.skipped.push("no D334 snapshot to pick senders from");
      return result;
    }
    const flagged = new Set((latest.trends ?? []).map((t) => t.email));
    const plan = sundaySenderPlan(
      Object.values(latest.rows),
      flagged,
      config.maxTests,
      config.maxSenders,
    ).filter((p) => p.senders.length);
    result.ran = true;
    if (this.deps.dryRun) {
      result.skipped.push(`dry run: would create ${plan.length} test(s)`);
      return result;
    }
    let providerIds: number[];
    try {
      providerIds = await smartDelivery.resolveProviderIds(this.deps.providerIds);
    } catch (error) {
      result.errors.push(`providers: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
    const template = defaultControlTemplate();
    for (const p of plan) {
      const name = `${SUNDAY_PLACEMENT_TEST_PREFIX} ${p.owner} ${latest.date}`.slice(0, 120);
      try {
        const created = await smartDelivery.createManualPlacement(
          isolationManualPayload({
            testName: name,
            description: `D335 Sunday-only placement check (${p.senders.length} senders, snapshot ${latest.date}). No action is taken on results.`,
            senderAccounts: p.senders,
            sequence: controlSequence(template, name),
            providerIds,
            offCampaignSenders: true,
          }),
        );
        result.created.push({ owner: p.owner, testId: String(created.id), senders: p.senders.length });
      } catch (error) {
        result.errors.push(`${p.owner}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }
}
