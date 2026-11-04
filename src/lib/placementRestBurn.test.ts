import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLACEMENT_REST_MS,
  planPlacementRestBurn,
  placementRestPhase,
  placementRestText,
} from "./placementRestBurn.js";

describe("D325 placement rest then burn", () => {
  it("rests four weeks and then is burn-due, without inventing a purge", () => {
    const plan = planPlacementRestBurn({
      campaignId: 11,
      campaignName: "Vector",
      at: "2026-11-04T18:00:00.000Z",
    });
    assert.equal(plan.phase, "rest");
    assert.equal(
      Date.parse(plan.restUntil) - Date.parse(plan.startedAt),
      PLACEMENT_REST_MS,
    );
    assert.equal(PLACEMENT_REST_MS, 28 * 24 * 60 * 60 * 1000);
    assert.equal(
      placementRestPhase(plan, new Date("2026-11-18T18:00:00.000Z")),
      "rest",
    );
    assert.equal(
      placementRestPhase(plan, new Date("2026-12-02T18:00:00.000Z")),
      "burn",
    );
    assert.match(placementRestText(plan), /rest 4 weeks, then burn/);
    assert.doesNotMatch(placementRestText(plan), /@/);
  });
});
