import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { SenderInboxRate } from "../clients/smartdelivery.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { HeldInboxRecord, StateStore } from "../state/store.js";
import { RemediationService } from "./remediation.js";

/**
 * D32 follow-through: a mailbox held on a blended score can never earn a fresh
 * same-ESP score, because being held removes it from the campaigns that feed
 * placement tests. The audit must release those rather than wait forever —
 * but must never hand back a sender that still fails the independent bounce
 * check (D5), since a held record does not say why it was held.
 */

const config = loadConfig({
  SCORE_SAME_ESP_ONLY: "true",
  MIN_SAME_ESP_SAMPLES: "3",
  REMEDIATION_INBOX_THRESHOLD: "80",
});

function held(
  email: string,
  scoredSameEsp: boolean | undefined,
  accountId: number,
): HeldInboxRecord {
  return {
    accountId,
    email,
    heldAt: "2026-08-05T00:00:00.000Z",
    holdUntil: "2026-08-19",
    tagName: "HOLD-UNTIL-2026-08-19",
    inboxRate: 20,
    scoredSameEsp,
    removedFromCampaigns: [10],
  };
}

function makeFixture(records: HeldInboxRecord[]) {
  const cleared: string[] = [];
  const state = {
    listHeldInboxes: () => records,
    getSwap: () => undefined,
    getRestingInbox: () => undefined,
    listRestingInboxes: () => [],
    clearHeldInbox: (e: string) => cleared.push(e.toLowerCase()),
    clearInboxRemediation: () => undefined,
  } as unknown as StateStore;

  const accounts = records.map((r) => ({
    id: r.accountId,
    from_email: r.email,
    type: "GMAIL",
    tags: [],
    campaign_ids: [],
  }));

  const smartlead = {
    listCampaigns: async () => [{ id: 10, name: "C", status: "ACTIVE", client_id: 1 }],
    getCampaignEmailAccounts: async () => [],
    listClients: async () => [{ id: 1, name: "Client" }],
    listTags: async () => [{ id: 7, name: "HOLD-UNTIL-2026-08-19" }],
    removeTags: async () => undefined,
    addEmailAccountsToCampaign: async () => undefined,
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

  return { service, accounts, cleared };
}

describe("D32 unproven blended holds", () => {
  it("releases a blended hold that never earned same-ESP evidence", async () => {
    const records = [held("blended@x.com", false, 1)];
    const { service, accounts, cleared } = makeFixture(records);

    const out = await service.auditAndRestoreFalseHolds({
      accounts: accounts as never,
      inboxRateRows: new Map<string, SenderInboxRate>(),
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.unprovenBlendedReleased, 1);
    assert.equal(out.restored.length, 1);
    assert.equal(out.restored[0]?.email, "blended@x.com");
    // No same-ESP number exists — the reason must not imply a healthy score.
    assert.equal(out.restored[0]?.inboxRate, undefined);
    assert.match(out.restored[0]?.reason ?? "", /no same-ESP evidence/i);
    assert.deepEqual(cleared, ["blended@x.com"]);
  });

  it("never releases a blended hold that still fails the bounce check", async () => {
    const records = [held("bouncer@x.com", false, 2)];
    const { service, accounts, cleared } = makeFixture(records);

    const out = await service.auditAndRestoreFalseHolds({
      accounts: accounts as never,
      inboxRateRows: new Map<string, SenderInboxRate>(),
      bounceRotations: new Map([["bouncer@x.com", 16.1]]),
      dryRun: false,
    });

    assert.equal(out.heldOnBounce, 1);
    assert.equal(out.unprovenBlendedReleased, 0);
    assert.equal(out.restored.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("leaves same-ESP and bounce-only holds alone — not a general amnesty", async () => {
    const records = [
      held("proper-sameesp@x.com", true, 3),
      held("bounce-only@x.com", undefined, 4),
    ];
    const { service, accounts, cleared } = makeFixture(records);

    const out = await service.auditAndRestoreFalseHolds({
      accounts: accounts as never,
      inboxRateRows: new Map<string, SenderInboxRate>(),
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.noSameEspEvidence, 2);
    assert.equal(out.unprovenBlendedReleased, 0);
    assert.equal(out.restored.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("keeps a hold that same-ESP evidence still condemns", async () => {
    const records = [held("reallybad@x.com", false, 5)];
    const { service, accounts, cleared } = makeFixture(records);

    const out = await service.auditAndRestoreFalseHolds({
      accounts: accounts as never,
      inboxRateRows: new Map<string, SenderInboxRate>([
        [
          "reallybad@x.com",
          {
            email: "reallybad@x.com",
            inboxRate: 0,
            inboxRateSameEsp: 0,
            sameEspSamples: 6,
            scoredSameEsp: true,
          } as SenderInboxRate,
        ],
      ]),
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.stillHeldBelowThreshold, 1);
    assert.equal(out.unprovenBlendedReleased, 0);
    assert.equal(out.restored.length, 0);
    assert.deepEqual(cleared, []);
  });

  it("never reattaches a generic across client boundaries (D26/D27)", async () => {
    // A generic-pool domain sits on many clients' campaigns, so expanding
    // targets by sending domain would put one mailbox on all of them.
    const record: HeldInboxRecord = {
      accountId: 9,
      email: "gen@pool.com",
      heldAt: "2026-08-05T00:00:00.000Z",
      holdUntil: "2026-08-19",
      tagName: "HOLD-UNTIL-2026-08-19",
      scoredSameEsp: false,
      removedFromCampaigns: [10],
    };
    const cleared: string[] = [];
    const state = {
      listHeldInboxes: () => [record],
      getSwap: () => undefined,
      getRestingInbox: () => undefined,
      listRestingInboxes: () => [],
      clearHeldInbox: (e: string) => cleared.push(e),
      clearInboxRemediation: () => undefined,
    } as unknown as StateStore;

    const poolAccount = {
      id: 9,
      from_email: "gen@pool.com",
      type: "GMAIL",
      tags: [],
      campaign_ids: [],
    };
    const smartlead = {
      listCampaigns: async () => [
        { id: 10, name: "ClientA", status: "ACTIVE", client_id: 1 },
        { id: 20, name: "ClientB", status: "ACTIVE", client_id: 2 },
      ],
      // Same pool domain is present on BOTH clients' campaigns.
      getCampaignEmailAccounts: async () => [poolAccount],
      listClients: async () => [
        { id: 1, name: "Client A" },
        { id: 2, name: "Client B" },
      ],
      listTags: async () => [{ id: 7, name: "HOLD-UNTIL-2026-08-19" }],
      removeTags: async () => undefined,
      addEmailAccountsToCampaign: async () => undefined,
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

    const out = await service.auditAndRestoreFalseHolds({
      accounts: [poolAccount] as never,
      inboxRateRows: new Map<string, SenderInboxRate>(),
      bounceRotations: new Map(),
      dryRun: true,
    });

    assert.equal(out.restored.length, 1);
    const targets = out.restored[0]?.reattachedCampaignIds ?? [];
    assert.ok(!targets.includes(20), "must not reattach to another client");
    assert.deepEqual(targets, [10]);
  });

  it("still restores on a healthy same-ESP score, with the rate recorded", async () => {
    const records = [held("recovered@x.com", false, 6)];
    const { service, accounts } = makeFixture(records);

    const out = await service.auditAndRestoreFalseHolds({
      accounts: accounts as never,
      inboxRateRows: new Map<string, SenderInboxRate>([
        [
          "recovered@x.com",
          {
            email: "recovered@x.com",
            inboxRate: 95,
            inboxRateSameEsp: 95,
            inboxRateAll: 40,
            sameEspSamples: 5,
            scoredSameEsp: true,
          } as SenderInboxRate,
        ],
      ]),
      bounceRotations: new Map(),
      dryRun: false,
    });

    assert.equal(out.falseHoldsFound, 1);
    assert.equal(out.restored[0]?.inboxRate, 95);
    assert.match(out.restored[0]?.reason ?? "", /same-ESP 95\.0%/);
  });
});
