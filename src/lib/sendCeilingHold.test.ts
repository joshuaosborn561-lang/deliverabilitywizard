import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import {
  accountMatchesTenantRateLimitHold,
  domainsShareBrandPrefix,
  effectiveMailboxMessagePerDay,
  mailboxSendCeilingNow,
  syncTenantRateLimitSendCeilingHolds,
  tenantCeilingRestoreAt,
  TENANT_CEILING_HOLD_TARGET,
} from "./sendCeilingHold.js";

const config = { messagePerDay: 30 };

function outlook(
  id: number,
  email: string,
  campaignIds: number[],
  perDay = 15,
): SmartleadAccountWithCampaigns {
  return {
    id,
    type: "OUTLOOK",
    from_email: email,
    message_per_day: perDay,
    campaign_ids: campaignIds,
  } as SmartleadAccountWithCampaigns;
}

describe("tenantCeilingRestoreAt (D191)", () => {
  it("is 00:15 UTC the next day for an afternoon bounce", () => {
    assert.equal(
      tenantCeilingRestoreAt("2026-09-10T20:50:00.000Z"),
      "2026-09-11T00:15:00.000Z",
    );
  });

  it("stays 00:15 UTC the same day when the bounce is after midnight but before grace", () => {
    assert.equal(
      tenantCeilingRestoreAt("2026-09-11T00:10:00.000Z"),
      "2026-09-11T00:15:00.000Z",
    );
  });

  it("rolls to the following 00:15 UTC after the grace window", () => {
    assert.equal(
      tenantCeilingRestoreAt("2026-09-11T00:20:00.000Z"),
      "2026-09-12T00:15:00.000Z",
    );
  });
});

describe("domainsShareBrandPrefix (D191)", () => {
  it("treats salesglidergo / salesgliderops as one family", () => {
    assert.equal(
      domainsShareBrandPrefix("salesglidergo.info", "salesgliderops.info"),
      true,
    );
    assert.equal(
      domainsShareBrandPrefix("salesgliderget.info", "salesgliderlab.info"),
      true,
    );
  });

  it("does not glue unrelated hosts", () => {
    assert.equal(
      domainsShareBrandPrefix("salesglidergo.info", "joshuaosales.com"),
      false,
    );
    assert.equal(
      domainsShareBrandPrefix("salesglidergo.info", "salesforce.com"),
      false,
    );
  });
});

describe("accountMatchesTenantRateLimitHold (D191)", () => {
  const verdict = {
    campaignId: 3921656,
    at: "2026-09-10T20:50:00.000Z",
    dominant: "tenant_rate_limit",
    summary: "tenant_rate_limit×4",
    senderDomains: ["salesglidergo.info", "salesgliderops.info"],
  };

  it("matches Outlook on the bursting campaign, Insight siblings, and domain family", () => {
    assert.equal(
      accountMatchesTenantRateLimitHold(
        outlook(1, "a@salesglidergo.info", [3921656]),
        verdict,
      ),
      true,
    );
    assert.equal(
      accountMatchesTenantRateLimitHold(
        outlook(2, "b@salesgliderget.info", []),
        verdict,
      ),
      true,
    );
    assert.equal(
      accountMatchesTenantRateLimitHold(
        outlook(3, "c@joshuaosales.com", [3921647]),
        verdict,
      ),
      true,
    );
  });

  it("matches Outlook already at 0 and ignores Gmail", () => {
    assert.equal(
      accountMatchesTenantRateLimitHold(
        outlook(4, "d@other.info", [], 0),
        verdict,
        0,
      ),
      true,
    );
    const gmail = {
      id: 5,
      type: "GMAIL",
      from_email: "e@salesglidergo.info",
      message_per_day: 30,
      campaign_ids: [3921656],
    } as SmartleadAccountWithCampaigns;
    assert.equal(accountMatchesTenantRateLimitHold(gmail, verdict), false);
  });
});

describe("syncTenantRateLimitSendCeilingHolds (D191)", () => {
  it("records 0-holds for matching Outlook and expires them after restoreAt", async () => {
    const store = new StateStore(
      `/tmp/ceiling-hold-${process.pid}-${Date.now()}.json`,
    );
    await store.load();
    store.setBounceVerdict({
      campaignId: 3921656,
      at: "2026-09-10T20:50:00.000Z",
      dominant: "tenant_rate_limit",
      summary: "tenant_rate_limit×4",
      senderDomains: ["salesglidergo.info"],
    });
    const accounts = [
      outlook(11, "a@salesglidergo.info", [3921656], 15),
      outlook(12, "b@joshuaosales.com", [3921656], 0),
      {
        id: 13,
        type: "GMAIL",
        from_email: "c@salesglidergo.info",
        message_per_day: 30,
        campaign_ids: [3921656],
      } as SmartleadAccountWithCampaigns,
    ];

    const during = Date.parse("2026-09-10T22:00:00.000Z");
    const synced = syncTenantRateLimitSendCeilingHolds({
      store,
      accounts,
      nowMs: during,
    });
    assert.equal(synced.held, 2);
    assert.equal(store.getSendCeilingHold(11)?.maxEmailPerDay, 0);
    assert.equal(store.getSendCeilingHold(12)?.restoreAt, "2026-09-11T00:15:00.000Z");
    assert.equal(store.getSendCeilingHold(13), undefined);
    assert.equal(
      mailboxSendCeilingNow(accounts[0], config, store, during),
      TENANT_CEILING_HOLD_TARGET,
    );
    assert.equal(
      mailboxSendCeilingNow(
        { type: "GMAIL", id: 13 },
        config,
        store,
        during,
      ),
      30,
    );

    const after = Date.parse("2026-09-11T00:16:00.000Z");
    const cleared = syncTenantRateLimitSendCeilingHolds({
      store,
      accounts,
      nowMs: after,
    });
    assert.equal(cleared.expired, 2);
    assert.equal(store.getSendCeilingHold(11), undefined);
    assert.equal(
      effectiveMailboxMessagePerDay(15, undefined, after),
      15,
    );
    assert.equal(mailboxSendCeilingNow(accounts[0], config, store, after), 15);
  });
});
