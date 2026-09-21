import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowsGenericStaff,
  clientCountKey,
  clientInboxStaffFloor,
  countClientInboxFloors,
  countClientInboxesByKey,
  countStaffableMemberships,
  detachWouldBreakOnWeekMin,
  detachWouldBreakStaffableFloor,
  formatStaffFloorDetail,
  noteStaffableDetach,
  ON_WEEK_MIN_SENDERS,
  staffFloorForCampaign,
} from "./clientStaffFloor.js";
import { onWeekCohort } from "./restCohort.js";

describe("clientInboxStaffFloor", () => {
  it("is half the client's own inboxes, rounded down", () => {
    assert.equal(clientInboxStaffFloor(80), 40);
    assert.equal(clientInboxStaffFloor(81), 40);
    assert.equal(clientInboxStaffFloor(25), 12);
    assert.equal(clientInboxStaffFloor(1), 0);
    assert.equal(clientInboxStaffFloor(0), 0);
  });
});

describe("detachWouldBreakOnWeekMin (D197)", () => {
  it("protects ACTIVE campaigns at or below 40 and ignores PAUSED", () => {
    assert.equal(ON_WEEK_MIN_SENDERS, 40);
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 40), true);
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 24), true);
    assert.equal(detachWouldBreakOnWeekMin({ status: "ACTIVE" }, 41), false);
    assert.equal(detachWouldBreakOnWeekMin({ status: "PAUSED" }, 40), false);
    assert.equal(detachWouldBreakOnWeekMin({ status: "STOPPED" }, 1), false);
    assert.equal(detachWouldBreakOnWeekMin(undefined, 40), false);
  });
});

describe("countStaffableMemberships / D199 peel floor", () => {
  const live = {
    id: 1,
    from_email: "live@parlay.test",
    is_smtp_success: true,
    is_imap_success: true,
    campaign_ids: [10],
  };
  const dead = {
    id: 2,
    from_email: "dead@parlay.test",
    is_smtp_success: false,
    is_imap_success: false,
    campaign_ids: [10],
  };

  it("ignores disconnected leftovers so a 40-seat restaff is not surplus", () => {
    const staffable = Array.from({ length: 40 }, (_, i) => ({
      id: 100 + i,
      from_email: `seat-${i}@parlay.test`,
      is_smtp_success: true,
      is_imap_success: true,
      campaign_ids: [10],
    }));
    const zombies = Array.from({ length: 32 }, (_, i) => ({
      id: 200 + i,
      from_email: `dead-${i}@parlay.test`,
      is_smtp_success: false,
      campaign_ids: [10],
    }));
    const counts = countStaffableMemberships([...staffable, ...zombies], {});
    assert.equal(counts.get(10), 40);
    assert.equal(
      detachWouldBreakOnWeekMin({ status: "ACTIVE" }, counts.get(10) ?? 0),
      true,
      "40 staffable + 32 disconnected is already at the floor",
    );
    assert.equal(
      detachWouldBreakStaffableFloor(
        { status: "ACTIVE" },
        counts.get(10) ?? 0,
        live,
        live.from_email,
        {},
      ),
      true,
    );
    assert.equal(
      detachWouldBreakStaffableFloor(
        { status: "ACTIVE" },
        counts.get(10) ?? 0,
        dead,
        dead.from_email,
        {},
      ),
      false,
      "disconnected leftovers may still come off",
    );
  });

  it("does not unlock a live seat after peeling a disconnected leftover", () => {
    const counts = new Map([[10, 40]]);
    noteStaffableDetach(counts, 10, dead, dead.from_email, {});
    assert.equal(counts.get(10), 40);
    assert.equal(
      detachWouldBreakStaffableFloor(
        { status: "ACTIVE" },
        counts.get(10) ?? 0,
        live,
        live.from_email,
        {},
      ),
      true,
    );
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
        prewarmedDomains: [],
      },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(counts.get(clientCountKey(9)), 2);
    assert.equal(
      staffFloorForCampaign({ client_id: 9, name: "Vasco - Service" }, counts),
      1,
    );
    assert.equal(
      staffFloorForCampaign(
        { client_id: 9, name: "Vasco - Service" },
        counts,
        "Vasco Warranty",
      ),
      1,
      "Vasco is not a full-send exception — floor is still half",
    );
  });

  it("D99: held inboxes do not inflate the half-floor", () => {
    const counts = countClientInboxesByKey(
      [
        { id: 1, from_email: "a@bcp.com", client_id: 9 },
        { id: 2, from_email: "b@bcp.com", client_id: 9 },
        {
          id: 3,
          from_email: "held@bcp.com",
          client_id: 9,
          // The live hold mechanism (D128): fan-out refuses this box, so
          // the floor must not count it as a box that could be sitting.
          tags: [{ tag_name: "HOLD-UNTIL-2099-01-01" }],
        },
        {
          id: 4,
          from_email: "released@bcp.com",
          client_id: 9,
          tags: [{ tag_name: "HOLD-UNTIL-2020-01-01" }],
        },
      ],
      [{ id: 1, name: "BCP Healthcare", status: "ACTIVE", client_id: 9 }],
      [{ id: 9, name: "BCP" }],
      { extraGenericMailboxes: [], extraGenericDomains: [], prewarmedDomains: [] },
      { getPoolMailbox: () => undefined },
    );
    assert.equal(counts.get(clientCountKey(9)), 3, "expired hold counts again");
    assert.equal(
      staffFloorForCampaign({ client_id: 9, name: "BCP Healthcare" }, counts),
      1,
    );
  });

  it("D176: attach-blocked inboxes do not inflate the half-floor", () => {
    const counts = countClientInboxesByKey(
      [
        { id: 1, from_email: "a@bcp.com", client_id: 9 },
        { id: 2, from_email: "b@bcp.com", client_id: 9 },
        {
          id: 3,
          from_email: "burned@boldercyperpartnerhub.info",
          client_id: 9,
        },
      ],
      [{ id: 1, name: "BCP Healthcare", status: "ACTIVE", client_id: 9 }],
      [{ id: 9, name: "BCP" }],
      { extraGenericMailboxes: [], extraGenericDomains: [], prewarmedDomains: [] },
      {
        getPoolMailbox: () => undefined,
        listAttachBlocks: () => [
          {
            domain: "boldercyperpartnerhub.info",
            emails: ["burned@boldercyperpartnerhub.info"],
            accountIds: [3],
            reason: "restricted",
            blockedAt: "2026-09-03T20:00:00.000Z",
          },
        ],
        listIsolationActions: () => [],
      },
    );
    assert.equal(counts.get(clientCountKey(9)), 2);
  });
});

describe("D196 on-week staff floor", () => {
  const emptyConfig = {
    extraGenericMailboxes: [] as string[],
    extraGenericDomains: [] as string[],
    prewarmedDomains: [] as string[],
  };
  const emptyState = { getPoolMailbox: () => undefined };
  const salesGlider = { id: 345263, name: "SalesGlider" };
  const campaign = {
    id: 3969109,
    name: "SG PE Origination - Thesis - A",
    status: "ACTIVE" as const,
    client_id: 345263,
  };

  function sgEligibleAccounts(): Array<{
    id: number;
    from_email: string;
    client_id: number;
    type: string;
  }> {
    const outlook = Array.from({ length: 63 }, (_, i) => ({
      id: i + 1,
      from_email: `outlook-${String(i).padStart(3, "0")}@salesglider.com`,
      client_id: 345263,
      type: "OUTLOOK",
    }));
    const gmail = Array.from({ length: 31 }, (_, i) => ({
      id: 100 + i,
      from_email: `gmail-${String(i).padStart(3, "0")}@salesglider.com`,
      client_id: 345263,
      type: "GMAIL",
    }));
    return [...outlook, ...gmail];
  }

  it("B week with ESP-odd 94 (A48/B46) floors at 46, not ceil-half 47", () => {
    const bWeek = new Date("2026-01-15T17:00:00Z");
    assert.equal(onWeekCohort(bWeek), "B");
    const floors = countClientInboxFloors(
      sgEligibleAccounts(),
      [campaign],
      [salesGlider],
      emptyConfig,
      emptyState,
      bWeek,
    );
    assert.equal(floors.eligible.get(clientCountKey(345263)), 94);
    assert.equal(floors.onWeek.get(clientCountKey(345263)), 46);
    const floor = staffFloorForCampaign(
      campaign,
      floors.eligible,
      "SalesGlider",
      floors.onWeek,
    );
    assert.equal(floor, 46);
    assert.equal(clientInboxStaffFloor(94), 47, "half of 94 stays 47");
    assert.equal(Math.max(0, floor - 46), 0, "46 staffable B seats is not understaffed");
    assert.equal(Math.max(0, floor - 45), 1, "45 staffable is short 1");
    assert.equal(
      formatStaffFloorDetail(46, floor, 94),
      "staffable 46/46 (on-week client pod)",
    );
  });

  it("A week floors at the larger ESP-odd pod (48), not half (47)", () => {
    const aWeek = new Date("2026-01-01T17:00:00Z");
    assert.equal(onWeekCohort(aWeek), "A");
    const floors = countClientInboxFloors(
      sgEligibleAccounts(),
      [campaign],
      [salesGlider],
      emptyConfig,
      emptyState,
      aWeek,
    );
    assert.equal(floors.onWeek.get(clientCountKey(345263)), 48);
    const floor = staffFloorForCampaign(
      campaign,
      floors.eligible,
      "SalesGlider",
      floors.onWeek,
    );
    assert.equal(floor, 48);
    assert.equal(Math.max(0, floor - 48), 0);
    assert.equal(Math.max(0, floor - 47), 1);
  });

  it("even split still reads as half this client's inboxes", () => {
    const accounts = Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      from_email: `box-${String(i).padStart(3, "0")}@client.info`,
      client_id: 9,
    }));
    const floors = countClientInboxFloors(
      accounts,
      [{ id: 1, name: "Vasco - Service", status: "ACTIVE", client_id: 9 }],
      [{ id: 9, name: "Vasco Warranty" }],
      emptyConfig,
      emptyState,
      new Date("2026-01-15T17:00:00Z"),
    );
    assert.equal(floors.eligible.get(clientCountKey(9)), 80);
    assert.equal(floors.onWeek.get(clientCountKey(9)), 40);
    const floor = staffFloorForCampaign(
      { client_id: 9, name: "Vasco - Service" },
      floors.eligible,
      "Vasco Warranty",
      floors.onWeek,
    );
    assert.equal(floor, 40);
    assert.equal(
      formatStaffFloorDetail(40, floor, 80),
      "staffable 40/40 (half this client's inboxes)",
    );
  });

  it("D197: an on-week pod smaller than 40 still floors at 40", () => {
    const accounts = Array.from({ length: 48 }, (_, i) => ({
      id: i + 1,
      from_email: `box-${String(i).padStart(3, "0")}@parlay.info`,
      client_id: 7,
    }));
    const bWeek = new Date("2026-01-15T17:00:00Z");
    const floors = countClientInboxFloors(
      accounts,
      [{ id: 1, name: "Parlay Sports", status: "ACTIVE", client_id: 7 }],
      [{ id: 7, name: "Parlay" }],
      emptyConfig,
      emptyState,
      bWeek,
    );
    assert.equal(floors.eligible.get(clientCountKey(7)), 48);
    assert.equal(floors.onWeek.get(clientCountKey(7)), 24);
    const floor = staffFloorForCampaign(
      { client_id: 7, name: "Parlay Sports" },
      floors.eligible,
      "Parlay",
      floors.onWeek,
    );
    assert.equal(floor, 40);
    assert.equal(
      formatStaffFloorDetail(24, floor, 48),
      "staffable 24/40 (on-week minimum 40)",
    );
  });

  it("generics still do not count toward the on-week floor (D193)", () => {
    const bWeek = new Date("2026-01-15T17:00:00Z");
    const floors = countClientInboxFloors(
      [
        ...sgEligibleAccounts(),
        {
          id: 900,
          from_email: "spare@crosslaunchco.com",
          client_id: 345263,
          type: "GMAIL",
        },
      ],
      [campaign],
      [salesGlider],
      { ...emptyConfig, extraGenericDomains: ["crosslaunchco.com"] },
      emptyState,
      bWeek,
    );
    assert.equal(floors.eligible.get(clientCountKey(345263)), 94);
    assert.equal(floors.onWeek.get(clientCountKey(345263)), 46);
  });
});
