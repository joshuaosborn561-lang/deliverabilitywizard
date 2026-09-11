import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignMayTakeGenerics,
  hasGenericBackfillApproval,
} from "./genericBackfill.js";

describe("campaignMayTakeGenerics", () => {
  it("D81: Goliath / POC campaigns may take generics", () => {
    assert.equal(
      campaignMayTakeGenerics(
        { id: 1, name: "Goliath Displacement M" },
        "Goliath Cybersecurity",
        ["goliath"],
        {},
      ),
      true,
    );
  });

  it("D193: a leftover D134 Slack approval does not open a named client campaign", () => {
    const approval = {
      "3847798": {
        campaignId: 3847798,
        approvedAt: "2026-09-01T00:00:00Z",
        approvedBy: "josh",
      },
    };
    assert.equal(
      campaignMayTakeGenerics(
        { id: 3847798, name: "TechEvo NE IT DM v2 Red Sox" },
        "TechEvolution",
        ["goliath"],
        approval,
      ),
      false,
    );
    assert.equal(
      campaignMayTakeGenerics(
        { id: 3763803, name: "BCP Logistics Under-1k (With Team)" },
        "BCP",
        ["goliath"],
        {
          "3763803": {
            campaignId: 3763803,
            approvedAt: "2026-09-01T00:00:00Z",
            approvedBy: "josh",
          },
        },
      ),
      false,
    );
    assert.equal(
      campaignMayTakeGenerics(
        { id: 3739758, name: "SalesGlider Engagers" },
        "SalesGlider",
        ["goliath"],
        {
          "3739758": {
            campaignId: 3739758,
            approvedAt: "2026-09-01T00:00:00Z",
            approvedBy: "josh",
          },
        },
      ),
      false,
    );
    assert.equal(
      hasGenericBackfillApproval(approval, 3847798),
      true,
      "D134 approvals are still recorded; they just do not staff",
    );
  });
});
