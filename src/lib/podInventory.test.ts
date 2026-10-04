import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  genericMayLinkToCampaigns,
  isOffWeekPodSeat,
  keepAssignedGenericForPodInventory,
  mailboxPodOf,
  podInventoryNeed,
} from "./podInventory.js";

/** ISO week 40 2026 — POD A on-week. */
const WEEK_A = new Date("2026-10-01T17:00:00Z");
/** ISO week 42 2026 — POD B on-week (fortnight block 1). */
const WEEK_B = new Date("2026-10-12T17:00:00Z");

describe("podInventory (D228)", () => {
  it("tops each POD to 40 independently", () => {
    assert.equal(podInventoryNeed(36, 4), 0);
    assert.equal(podInventoryNeed(36, 0), 4);
    assert.equal(podInventoryNeed(40, 2), 0);
    assert.equal(podInventoryNeed(40, 0), 0);
  });

  it("off-week tagged generics do not link to campaigns", () => {
    const offB = { tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }] };
    assert.equal(mailboxPodOf(offB), "B");
    assert.equal(isOffWeekPodSeat(offB, WEEK_A), true);
    assert.equal(genericMayLinkToCampaigns(offB, WEEK_A), false);
    assert.equal(genericMayLinkToCampaigns(offB, WEEK_B), true);
    assert.equal(
      genericMayLinkToCampaigns({ tags: [{ tag_name: "GENERIC" }] }, WEEK_A),
      true,
      "untagged generics are not treated as off-week",
    );
  });

  it("keeps a needed off-week assignment with no campaign links", () => {
    assert.equal(
      keepAssignedGenericForPodInventory({
        email: "keep@getintroduced.info",
        tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
        idleEmails: [],
      }),
      true,
    );
    assert.equal(
      keepAssignedGenericForPodInventory({
        email: "extra@getintroduced.info",
        tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
        idleEmails: ["extra@getintroduced.info"],
      }),
      false,
      "surplus in THAT POD still returns",
    );
    assert.equal(
      keepAssignedGenericForPodInventory({
        email: "gone@getintroduced.info",
        tags: [{ tag_name: "GENERIC" }],
        idleEmails: [],
      }),
      false,
      "untagged leftovers still follow D205 cleanup",
    );
  });
});
