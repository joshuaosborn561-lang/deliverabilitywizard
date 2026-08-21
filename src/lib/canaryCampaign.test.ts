import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canaryAllowsClientInbox,
  droppedUnrelatedDomains,
  isCanaryCampaign,
  shouldPauseCanaryForDomainDrops,
} from "./canaryCampaign.js";
import { hashEmail } from "./restCohort.js";

describe("canaryCampaign", () => {
  const now = new Date("2026-08-21T12:00:00Z");

  it("treats a campaign created in the last 7 days as a canary", () => {
    assert.equal(
      isCanaryCampaign({ created_at: "2026-08-18T00:00:00Z" }, now, 7),
      true,
    );
    assert.equal(
      isCanaryCampaign({ created_at: "2026-08-01T00:00:00Z" }, now, 7),
      false,
    );
    assert.equal(isCanaryCampaign({}, now, 7), false);
  });

  it("allows about 15% of addresses onto a canary", () => {
    let allowed = 0;
    const emails = Array.from({ length: 200 }, (_, i) => `user${i}@client.info`);
    for (const email of emails) {
      if (canaryAllowsClientInbox(email, 15)) allowed += 1;
      assert.equal(
        canaryAllowsClientInbox(email, 15),
        hashEmail(email) % 100 < 15,
      );
    }
    assert.ok(allowed > 10 && allowed < 50, `got ${allowed}/200`);
  });

  it("pauses only when 3+ unrelated domains have dropped", () => {
    assert.equal(shouldPauseCanaryForDomainDrops(2), false);
    assert.equal(shouldPauseCanaryForDomainDrops(3), true);
    assert.equal(shouldPauseCanaryForDomainDrops(5, 3), true);
  });

  it("counts unique sending domains with a known-bad same-ESP score", () => {
    const dropped = droppedUnrelatedDomains(
      [
        { domain: "a.info", sameEspInbox: 40, scoredSameEsp: true },
        { domain: "a.info", sameEspInbox: 30, scoredSameEsp: true },
        { domain: "b.info", sameEspInbox: 10, scoredSameEsp: true },
        { domain: "c.info", sameEspInbox: 90, scoredSameEsp: true },
        { domain: "d.info", sameEspInbox: 20, scoredSameEsp: false },
      ],
      80,
    );
    assert.deepEqual(dropped.sort(), ["a.info", "b.info"]);
  });
});
