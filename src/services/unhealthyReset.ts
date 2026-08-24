import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { sleep } from "../lib/http.js";
import { tagNames } from "./warmupGate.js";
import type { StateStore } from "../state/store.js";

export interface UnhealthyResetResult {
  dryRun: boolean;
  skipped: boolean;
  heldCleared: number;
  tagsStripped: number;
  swapsCleared: number;
  mailboxControlsCleared: number;
  restProofCleared: number;
  remediationsCleared: number;
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
 * D59 — one-shot: every leftover unhealthy mark goes away. Holds, HOLD-UNTIL
 * tags, kill/watch control tags, and old same-ESP rest vetoes are not
 * unhealth until the new rules mark them again. A/B sit is not a hold.
 */
export class UnhealthyResetService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<UnhealthyResetResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: UnhealthyResetResult = {
      dryRun,
      skipped: false,
      heldCleared: 0,
      tagsStripped: 0,
      swapsCleared: 0,
      mailboxControlsCleared: 0,
      restProofCleared: 0,
      remediationsCleared: 0,
      errors: [],
    };

    if (!this.config.enableUnhealthyReset) {
      result.skipped = true;
      return result;
    }
    if (this.state.getUnhealthyResetAt()) {
      result.skipped = true;
      return result;
    }

    const accounts = (await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    })) as SmartleadAccountWithCampaigns[];

    const catalogHoldIds = new Set<number>();
    try {
      for (const tag of await this.smartlead.listTags()) {
        if (/^HOLD-UNTIL-/i.test(tag.name)) catalogHoldIds.add(tag.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list tags: ${message}`);
    }

    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || !account.id) continue;
      const onAccount = holdTagIdsOnAccount(account);
      const names = tagNames(account);
      const hasHold = names.some((name) => /^HOLD-UNTIL-/i.test(name));
      const stripIds = onAccount.length
        ? onAccount
        : hasHold
          ? [...catalogHoldIds]
          : [];
      if (!stripIds.length || dryRun) {
        if (hasHold) result.tagsStripped += stripIds.length || 1;
        continue;
      }
      try {
        await this.smartlead.removeTags([account.id], stripIds);
        result.tagsStripped += stripIds.length;
        await sleep(80);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email} strip tags: ${message}`);
      }
    }

    if (!dryRun) {
      result.heldCleared = this.state.clearAllHeldInboxes();
      result.mailboxControlsCleared = this.state.clearMailboxControls();
      result.restProofCleared = this.state.clearClientRestProof();
      result.remediationsCleared = this.state.clearInboxRemediations();
      this.state.clearHeldPlacementTests();
      for (const swap of this.state.listActiveSwaps()) {
        this.state.releaseSwapReservation(swap.originalEmail);
        result.swapsCleared += 1;
      }
      if (!result.errors.length) {
        this.state.markUnhealthyReset(new Date().toISOString());
      }
      await this.state.save();
    } else {
      result.heldCleared = this.state.listHeldInboxes().length;
      result.mailboxControlsCleared = this.state.listMailboxControls().length;
      result.swapsCleared = this.state.listActiveSwaps().length;
    }

    console.log(
      `[unhealthy-reset] held=${result.heldCleared} tags=${result.tagsStripped} swaps=${result.swapsCleared} controls=${result.mailboxControlsCleared} errors=${result.errors.length}`,
    );
    if (result.heldCleared || result.tagsStripped) {
      try {
        await this.slack.send(
          [
            `${dryRun ? "Preview — " : ""}Starting clean`,
            `Cleared ${result.heldCleared} old “unhealthy” hold${result.heldCleared === 1 ? "" : "s"} and ${result.tagsStripped} HOLD-UNTIL tag${result.tagsStripped === 1 ? "" : "s"}.`,
            `Nothing is unhealthy until the new rules mark it. Group ${onWeekCohort()} sends this fortnight — those client inboxes go back on their campaigns.`,
          ].join("\n"),
        );
      } catch (error) {
        console.warn("[unhealthy-reset] Slack notify failed", error);
      }
    }
    return result;
  }
}
