import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { HeldInboxRecord, StateStore } from "../state/store.js";
import { RemediationService } from "./remediation.js";

/**
 * D6 holds a benched sender 14 days "before returning", but nothing ever
 * returned them — a heldInboxes record had no expiry, so the mailbox stayed
 * out of supply forever.
 */

const config = loadConfig({ RECOVERY_HOLD_DAYS: "14" });

function agoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function held(
  email: string,
  daysAgo: number,
  stampedUntil?: string,
): HeldInboxRecord {
  return {
    accountId: 1,
    email,
    heldAt: agoIso(daysAgo),
    holdUntil: stampedUntil ?? "2026-08-17",
    tagName: "HOLD-UNTIL-2026-08-17",
  };
}

function fixture(records: HeldInboxRecord[], opts: { swaps?: string[] } = {}) {
  const cleared: string[] = [];
  const clearedRemediation: string[] = [];
  const removedTags: Array<[number[], number[]]> = [];
  const swaps = new Set((opts.swaps ?? []).map((s) => s.toLowerCase()));

  const state = {
    listHeldInboxes: () => records,
    getSwap: (email: string) => (swaps.has(email.toLowerCase()) ? {} : undefined),
    clearHeldInbox: (e: string) => cleared.push(e.toLowerCase()),
    clearInboxRemediation: (e: string) => clearedRemediation.push(e.toLowerCase()),
  } as unknown as StateStore;

  const smartlead = {
    removeTags: async (accountIds: number[], tagIds: number[]) => {
      removedTags.push([accountIds, tagIds]);
    },
  } as unknown as SmartleadClient;

  const service = new RemediationService(
    config,
    smartlead,
    {} as unknown as SmartDeliveryClient,
    null,
    { send: async () => undefined } as unknown as SlackClient,
    state,
    undefined as never,
  );
  return { service, cleared, clearedRemediation, removedTags };
}

const account = (email: string) => ({
  id: 1,
  from_email: email,
  tags: [{ tag_id: 7, tag_name: "HOLD-UNTIL-2026-08-17" }],
  campaign_ids: [],
});

describe("releasing holds that served their term", () => {
  it("releases a hold past the term even when stamped for longer", async () => {
    // The real case: pre-D6 holds carry a 28-day stamp from the old
    // "+4 weeks" default, but D6 only ever asked for 14.
    const { service, cleared, clearedRemediation, removedTags } = fixture([
      held("old@x.com", 23.7, "2026-08-17"),
    ]);

    const out = await service.releaseServedHolds({
      accounts: [account("old@x.com")] as never,
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.released.length, 1);
    assert.equal(out.released[0]?.email, "old@x.com");
    assert.deepEqual(cleared, ["old@x.com"]);
    // Both gates must clear or the main loop still skips it.
    assert.deepEqual(clearedRemediation, ["old@x.com"]);
    assert.deepEqual(removedTags, [[[1], [7]]]);
  });

  it("leaves a hold that has not served the term", async () => {
    const { service, cleared } = fixture([held("fresh@x.com", 3)]);

    const out = await service.releaseServedHolds({
      accounts: [account("fresh@x.com")] as never,
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.released.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("keeps a served hold whose sender still fails bounce (D5)", async () => {
    const { service, cleared } = fixture([held("bouncer@x.com", 30)]);

    const out = await service.releaseServedHolds({
      accounts: [account("bouncer@x.com")] as never,
      bounceRotations: new Map([["bouncer@x.com", 22.4]]),
      dryRun: false,
    });

    assert.equal(out.keptOnBounce, 1);
    assert.equal(out.released.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("does not pre-empt an active pool swap", async () => {
    const { service, cleared } = fixture([held("swapped@x.com", 30)], {
      swaps: ["swapped@x.com"],
    });

    const out = await service.releaseServedHolds({
      accounts: [account("swapped@x.com")] as never,
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.skippedActiveSwap, 1);
    assert.equal(out.released.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("writes nothing on a dry run but still reports the release", async () => {
    const { service, cleared, removedTags } = fixture([held("old@x.com", 30)]);

    const out = await service.releaseServedHolds({
      accounts: [account("old@x.com")] as never,
      bounceRotations: new Map(),
      dryRun: true,
    });

    assert.equal(out.released.length, 1);
    assert.deepEqual(cleared, []);
    assert.deepEqual(removedTags, []);
  });
});
