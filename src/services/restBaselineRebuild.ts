import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { holdHasSameEspProof } from "../lib/holdProof.js";
import { sleep } from "../lib/http.js";
import { tagNames } from "./warmupGate.js";
import type { StateStore } from "../state/store.js";

export interface RestBaselineRebuildResult {
  dryRun: boolean;
  skipped: boolean;
  examined: number;
  kept: number;
  released: string[];
  tagsStripped: number;
  swapsCleared: number;
  errors: string[];
}

function holdTagIdsOnAccount(
  account: SmartleadAccountWithCampaigns,
): number[] {
  const ids: number[] = [];
  for (const tag of account.tags ?? []) {
    const name = String(tag.tag_name ?? tag.name ?? "");
    if (!/^HOLD-UNTIL-/i.test(name)) continue;
    const id = tag.tag_id ?? tag.id;
    if (typeof id === "number") ids.push(id);
  }
  return ids;
}

/**
 * D44 — one-shot: drop HOLD state/tags that are not proven-weak on same-ESP
 * so D43 A/B rest can take over. Real same-ESP fails stay held (D5/D32).
 */
export class RestBaselineRebuildService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<RestBaselineRebuildResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: RestBaselineRebuildResult = {
      dryRun,
      skipped: false,
      examined: 0,
      kept: 0,
      released: [],
      tagsStripped: 0,
      swapsCleared: 0,
      errors: [],
    };

    if (!this.config.enableRestBaselineRebuild) {
      result.skipped = true;
      return result;
    }
    if (this.state.getRestBaselineRebuiltAt()) {
      result.skipped = true;
      return result;
    }

    const threshold = this.config.remediationInboxThreshold;
    const accounts = (await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    })) as SmartleadAccountWithCampaigns[];
    const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
    for (const account of accounts) {
      const email = accountEmail(account);
      if (email) byEmail.set(email.toLowerCase(), account);
    }

    const catalogHoldIds = new Set<number>();
    try {
      for (const tag of await this.smartlead.listTags()) {
        if (/^HOLD-UNTIL-/i.test(tag.name)) catalogHoldIds.add(tag.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list tags: ${message}`);
    }

    const seen = new Set<string>();
    const release = async (
      email: string,
      account: SmartleadAccountWithCampaigns | undefined,
    ) => {
      if (seen.has(email)) return;
      seen.add(email);
      const onAccount = account ? holdTagIdsOnAccount(account) : [];
      const stripIds = onAccount.length ? onAccount : [...catalogHoldIds];
      if (account?.id && stripIds.length && !dryRun) {
        try {
          await this.smartlead.removeTags([account.id], stripIds);
          result.tagsStripped += stripIds.length;
          await sleep(80);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`${email} strip tags: ${message}`);
        }
      }
      if (this.state.getSwap(email)) {
        if (!dryRun) this.state.releaseSwapReservation(email);
        result.swapsCleared += 1;
      }
      if (!dryRun) {
        this.state.clearHeldInbox(email);
        this.state.clearInboxRemediation(email);
      }
      result.released.push(email);
    };

    for (const record of this.state.listHeldInboxes()) {
      result.examined += 1;
      const email = record.email.toLowerCase();
      if (holdHasSameEspProof(record, threshold)) {
        result.kept += 1;
        seen.add(email);
        continue;
      }
      await release(email, byEmail.get(email));
    }

    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || !account.id) continue;
      const names = tagNames(account);
      if (!names.some((name) => /^HOLD-UNTIL-/i.test(name))) continue;
      if (seen.has(email)) continue;
      result.examined += 1;
      const record = this.state.getHeldInbox(email);
      if (record && holdHasSameEspProof(record, threshold)) {
        result.kept += 1;
        seen.add(email);
        continue;
      }
      await release(email, account);
    }

    if (!dryRun && result.errors.length === 0) {
      this.state.markRestBaselineRebuilt(new Date().toISOString());
      await this.state.save();
    }

    console.log(
      `[rest-baseline] released=${result.released.length} kept=${result.kept} tags=${result.tagsStripped} swaps=${result.swapsCleared} errors=${result.errors.length}`,
    );
    if (result.released.length || result.kept) {
      try {
        await this.slack.send(
          [
            `${dryRun ? "Preview — " : ""}Inbox hold clean-up`,
            `We took ${result.released.length} inbox${result.released.length === 1 ? "" : "es"} off “held.” They weren’t actually failing inbox tests, so they can send again on their normal schedule.`,
            `${result.kept} stay held — ${result.kept === 1 ? "that one really failed" : "those really failed"} inbox tests.`,
            result.swapsCleared
              ? `${result.swapsCleared} backup inbox${result.swapsCleared === 1 ? "" : "es"} we had reserved for them stay where they are (still sending).`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        console.warn("[rest-baseline] Slack notify failed", error);
      }
    }
    return result;
  }
}
