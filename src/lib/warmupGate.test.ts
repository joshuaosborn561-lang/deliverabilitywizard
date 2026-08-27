import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeHoldUntilDate,
  daysSince,
  isActiveCampaignStatus,
  isPrewarmedGeneric,
  owedWarmupDays,
  warmupClockStartedAt,
  warmupStartedAt,
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
