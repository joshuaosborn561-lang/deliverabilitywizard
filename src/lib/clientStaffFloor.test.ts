import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowsGenericStaff,
  clientCountKey,
  clientInboxStaffFloor,
  countClientInboxesByKey,
  staffFloorForCampaign,
} from "./clientStaffFloor.js";

describe("clientInboxStaffFloor", () => {
  it("is half the client's own inboxes, rounded down", () => {
    assert.equal(clientInboxStaffFloor(80), 40);
    assert.equal(clientInboxStaffFloor(81), 40);
    assert.equal(clientInboxStaffFloor(25), 12);
    assert.equal(clientInboxStaffFloor(1), 0);
    assert.equal(clientInboxStaffFloor(0), 0);
  });
});

describe("allowsGenericStaff", () => {
  it("matches Goliath on the campaign or the client name (D58)", () => {
    assert.equal(
      allowsGenericStaff(
        { name: "Goliath Displacement L 501-1000 ITDir" },
        "Other",
        ["goliath"],
      ),
      true,
    );
    assert.equal(
      allowsGenericStaff(
        { name: "Education Receipts" },
        "Goliath Cybersecurity (Dave Ackley)",
        ["goliath"],
      ),
      true,
    );
    assert.equal(
      allowsGenericStaff({ name: "Vasco - Service - Nissan" }, "Vasco Warranty", [
        "goliath",
      ]),
      false,
    );
  });
});

describe("countClientInboxesByKey / staffFloorForCampaign", () => {
  it("counts client inboxes and ignores generics", () => {
    const counts = countClientInboxesByKey(
      [
        { id: 1, from_email: "a@vasco.com", client_id: 9 },
        { id: 2, from_email: "b@vasco.com", client_id: 9 },
        { id: 3, from_email: "spare@crosslaunchco.com", client_id: 9 },
      ],
      [{ id: 1, name: "Vasco", status: "ACTIVE", client_id: 9 }],
      [{ id: 9, name: "Vasco Warranty" }],
      {
        extraGenericMailboxes: [],
        extraGenericDomains: ["crosslaunchco.com"],
      },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(counts.get(clientCountKey(9)), 2);
  });

  it("counts POC generics toward that client's floor (D70)", () => {
    const counts = countClientInboxesByKey(
      [
        {
          id: 1,
          from_email: "a@crosslaunchco.com",
          client_id: 11,
          campaign_ids: [80],
        },
        {
          id: 2,
          from_email: "b@crosslaunchco.com",
          client_id: 11,
          campaign_ids: [80],
        },
        {
          id: 3,
          from_email: "c@crosslaunchco.com",
          client_id: 11,
          campaign_ids: [80],
        },
      ],
      [{ id: 80, name: "Goliath Displacement L", status: "ACTIVE", client_id: 11 }],
      [{ id: 11, name: "Dave Ackley" }],
      {
        extraGenericMailboxes: [],
        extraGenericDomains: ["crosslaunchco.com"],
        pocClientPatterns: ["goliath"],
      },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(counts.get(clientCountKey(11)), 3);
    assert.equal(
      staffFloorForCampaign({ client_id: 11, name: "Goliath Displacement L" }, counts),
      1,
    );
  });

  it("counts a sitting POC generic toward the floor (D70)", () => {
    const counts = countClientInboxesByKey(
      [
        {
          id: 1,
          from_email: "sit@crosslaunchco.com",
          client_id: 11,
          campaign_ids: [],
        },
        {
          id: 2,
          from_email: "live@crosslaunchco.com",
          client_id: 11,
          campaign_ids: [80],
        },
      ],
      [{ id: 80, name: "Goliath Displacement L", status: "ACTIVE", client_id: 11 }],
      [{ id: 11, name: "Dave Ackley" }],
      {
        extraGenericMailboxes: [],
        extraGenericDomains: ["crosslaunchco.com"],
        pocClientPatterns: ["goliath"],
      },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(counts.get(clientCountKey(11)), 2);
    assert.equal(
      staffFloorForCampaign({ client_id: 11, name: "Goliath Displacement L" }, counts),
      1,
    );
  });
});
