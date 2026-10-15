import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSlimEmailAccountsJson,
  slimAccountMemberships,
  SLIM_EMAIL_ACCOUNTS_OFFTHREAD_CHARS,
} from "./accountMembership.js";

describe("D269 slim email-account memberships", () => {
  it("keeps campaign_ids and drops the embedded campaigns array", () => {
    const account = {
      id: 1,
      from_email: "ada@crosslaunchco.com",
      campaign_ids: [10, 11],
      campaigns: [
        { id: 10, name: "A", status: "ACTIVE" },
        { id: 11, name: "B", status: "PAUSED" },
      ],
    };
    slimAccountMemberships(account);
    assert.deepEqual(account.campaign_ids, [10, 11]);
    assert.equal("campaigns" in account, false);
  });

  it("fills campaign_ids from campaigns when the id list is missing", () => {
    const account = {
      id: 2,
      from_email: "bob@crosslaunchco.com",
      campaigns: [{ campaign_id: 22, name: "C" }],
    };
    slimAccountMemberships(account);
    assert.deepEqual(account.campaign_ids, [22]);
    assert.equal("campaigns" in account, false);
  });

  it("parses a fat page off-thread without pinning the event loop", async () => {
    const fatCampaigns = Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      name: `Campaign ${i} ${"x".repeat(80)}`,
      status: "ACTIVE",
      client_id: 77,
    }));
    const page = Array.from({ length: 40 }, (_, i) => ({
      id: 1000 + i,
      from_email: `seat${i}@crosslaunchco.com`,
      campaign_ids: fatCampaigns.map((row) => row.id),
      campaigns: fatCampaigns,
    }));
    const text = JSON.stringify(page);
    assert.ok(text.length > SLIM_EMAIL_ACCOUNTS_OFFTHREAD_CHARS);

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    timer.unref?.();
    const slim = await parseSlimEmailAccountsJson(text);
    clearInterval(timer);

    assert.equal(slim.length, 40);
    assert.equal(slim[0]?.campaign_ids?.length, 80);
    assert.equal("campaigns" in (slim[0] ?? {}), false);
    assert.ok(ticks > 0, "off-thread slim parse must let the event loop tick");
  });
});
