import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import {
  activeHoldUntilDate,
  countsAsWarmed21,
  daysSince,
  isActiveCampaignStatus,
  isPrewarmedGeneric,
  owedWarmupDays,
  owesWarmup,
  warmupClockStartedAt,
  warmupStartedAt,
  WarmupGateService,
} from "../services/warmupGate.js";

describe("warmupGate helpers", () => {
  it("detects ACTIVE campaign statuses", () => {
    assert.equal(isActiveCampaignStatus("ACTIVE"), true);
    assert.equal(isActiveCampaignStatus("START"), true);
    assert.equal(isActiveCampaignStatus("PAUSED"), false);
  });

  it("treats future HOLD-UNTIL as active", () => {
    const hold = activeHoldUntilDate(
      ["HOLD-UNTIL-2099-01-15"],
      new Date("2026-07-22T12:00:00Z"),
    );
    assert.equal(hold, "2099-01-15");
  });

  it("ignores expired HOLD-UNTIL", () => {
    const hold = activeHoldUntilDate(
      ["HOLD-UNTIL-2020-01-01"],
      new Date("2026-07-22T12:00:00Z"),
    );
    assert.equal(hold, null);
  });

  it("prefers warmup_details created_at", () => {
    const started = warmupStartedAt({
      id: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      warmup_details: { created_at: "2026-06-01T00:00:00.000Z" },
    });
    assert.equal(started, "2026-06-01T00:00:00.000Z");
  });

  it("computes days since", () => {
    const days = daysSince(
      "2026-07-08T12:00:00.000Z",
      Date.parse("2026-07-22T12:00:00.000Z"),
    );
    assert.equal(days, 14);
  });

  it("exempts every mailbox on an explicit pre-warmed fleet domain", () => {
    const result = isPrewarmedGeneric(
      { id: 1, from_name: "Brianna Escobar" },
      "escobar.br@crossscaleco.com",
      {
        extraGenericMailboxes: ["breanna escobar"],
        prewarmedDomains: [
          "crossscaleco.com",
          "crosslaunchco.com",
          "cleartechco.com",
        ],
      },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(result, true);
    assert.equal(
      isPrewarmedGeneric(
        { id: 2, from_name: "Daisy Wagner" },
        "wagner.d@cleartechco.com",
        {
          extraGenericMailboxes: [],
          prewarmedDomains: [
            "crossscaleco.com",
            "crosslaunchco.com",
            "cleartechco.com",
          ],
        },
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
  });

  it("honors persisted pre-warmed state and fuzzy fleet names", () => {
    const config = {
      extraGenericMailboxes: ["breanna escobar"],
      prewarmedDomains: [],
    };
    assert.equal(
      isPrewarmedGeneric(
        { id: 1, from_name: "Brianna Escobar" },
        "alias@other.com",
        config,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
    assert.equal(
      isPrewarmedGeneric(
        { id: 2, from_name: "Different Person" },
        "known@other.com",
        { extraGenericMailboxes: [], prewarmedDomains: [] },
        {
          getPoolMailbox: () =>
            ({
              email: "known@other.com",
              prewarmed: true,
            }) as never,
        },
      ),
      true,
    );
  });

  it("owes 21 days for fresh inboxes; pre-warmed follow campaignMinWarmupDays", () => {
    assert.equal(
      owedWarmupDays(false, {
        campaignMinWarmupDays: 21,
        freshInboxWarmupDays: 21,
      }),
      21,
    );
    assert.equal(
      owedWarmupDays(true, {
        campaignMinWarmupDays: 21,
        freshInboxWarmupDays: 21,
      }),
      21,
    );
  });

  it("prefers the InboxKit import stamp over Smartlead's warmup record", () => {
    const started = warmupClockStartedAt(
      {
        id: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        warmup_details: { created_at: "2026-01-01T00:00:00.000Z" },
      },
      "cold@pool.info",
      {
        getPoolMailbox: () =>
          ({
            email: "cold@pool.info",
            warmedAt: "2026-08-10T00:00:00.000Z",
          }) as never,
      },
    );
    assert.equal(started, "2026-08-10T00:00:00.000Z");
  });

  it("falls back to Smartlead when the mailbox is not in the pool", () => {
    const started = warmupClockStartedAt(
      {
        id: 2,
        created_at: "2026-01-01T00:00:00.000Z",
        warmup_details: { created_at: "2026-06-01T00:00:00.000Z" },
      },
      "client@brand.com",
      { getPoolMailbox: () => undefined },
    );
    assert.equal(started, "2026-06-01T00:00:00.000Z");
  });

  it("D227: WARMUP-GATE-EXEMPT counts as 21+ days and does not owe warmup", () => {
    const now = Date.parse("2026-10-04T00:04:00.000Z");
    const days = daysSince("2026-09-29T00:00:00.000Z", now);
    assert.ok(days < 21, "9/29 → 10/4 is still under 21 days");
    assert.equal(countsAsWarmed21([], days), false);
    assert.equal(countsAsWarmed21(["WARMUP-GATE-EXEMPT"], days), true);
    assert.equal(countsAsWarmed21(["warmup-gate-exempt", "type:azure"], 5), true);
    assert.equal(countsAsWarmed21([], 21), true);

    const config = {
      campaignMinWarmupDays: 21,
      freshInboxWarmupDays: 21,
      prewarmedDomains: [],
      extraGenericMailboxes: [],
    };
    const state = { getPoolMailbox: () => undefined, isCopyCanary: () => false };
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const tidal = {
      id: 1,
      from_email: "ada@tidalstackco.com",
      created_at: fiveDaysAgo,
      warmup_details: { created_at: fiveDaysAgo },
      tags: [{ tag_name: "WARMUP-GATE-EXEMPT" }, { tag_name: "type:azure" }],
    };
    assert.equal(
      owesWarmup(tidal, "ada@tidalstackco.com", config, state),
      false,
    );
    assert.equal(
      owesWarmup(
        { ...tidal, tags: [{ tag_name: "type:azure" }] },
        "ada@tidalstackco.com",
        config,
        state,
      ),
      true,
    );
  });

  it("does not exempt unrelated client mailboxes", () => {
    assert.equal(
      isPrewarmedGeneric(
        { id: 1, from_name: "Marcus Escobar" },
        "marcus@client.info",
        {
          extraGenericMailboxes: ["breanna escobar"],
          prewarmedDomains: ["crossscaleco.com"],
        },
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
  });
});

describe("WarmupGateService D241", () => {
  it("does not pull a GABE-VM-RESERVED seat", async () => {
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(
      `/tmp/warmup-gabe-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = new WarmupGateService(
      loadConfig({ ENABLE_WARMUP_GATE: "true", DRY_RUN: "false" }),
      {
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
        getEmailAccount: async () => {
          throw new Error("should not fetch reserved");
        },
      } as unknown as SmartleadClient,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      inventory: {
        fetchedAt: Date.now(),
        clients: [],
        campaigns: [
          { id: 1, name: "SalesGlider Engagers", status: "ACTIVE", client_id: 345263 },
        ],
        accounts: [
          {
            id: 24255314,
            from_email: "gabriel@salesglider.com",
            created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            campaign_ids: [1],
            tags: [{ tag_name: "GABE-VM-RESERVED" }],
          },
        ],
      },
    });
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
    assert.equal(result.removals.length, 0);
  });
});
