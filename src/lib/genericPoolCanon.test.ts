import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ON_WEEK_MIN_SENDERS,
  POD_INVENTORY_MIN_SENDERS,
  podGenericTopUpCap,
} from "./clientStaffFloor.js";
import { POWERGRYD_CLIENT_ID } from "./autoAllowGenerics.js";
import { CANON_CORE_KINDS } from "./canonCompliance.js";
import {
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  GENERIC_ASSIGN_REASON_POWERGRYD,
  GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE,
  GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE_ALIAS,
  GENERIC_POOL_CORE_KINDS,
  GENERIC_POOL_POD_FLOOR,
  GENERIC_POOL_POWERGRYD_CLIENT_ID,
  clientPodKey,
  emptyGenericSeat,
  genericPoolNeedForPod,
  genericProviderFromAccountType,
  podFromMailboxTags,
} from "./genericPool.js";
import {
  genericPoolCanonCompliant,
  genericPoolFindingLine,
  syncGenericSeatsFromInventory,
  validateGenericPool,
} from "./genericPoolCanon.js";

function seat(
  email: string,
  extras: Parameters<typeof emptyGenericSeat>[1] = {},
) {
  return emptyGenericSeat(email, extras);
}

describe("D221 generic-pool constants", () => {
  it("locks the fleet-wide pool floor at 40 per POD", () => {
    assert.equal(GENERIC_POOL_POD_FLOOR, 40);
    assert.equal(GENERIC_POOL_POD_FLOOR, ON_WEEK_MIN_SENDERS);
    assert.equal(GENERIC_POOL_POD_FLOOR, POD_INVENTORY_MIN_SENDERS);
    assert.equal(genericPoolNeedForPod(40), 0);
    assert.equal(genericPoolNeedForPod(24), 16);
    assert.equal(genericPoolNeedForPod(24), podGenericTopUpCap(24));
    assert.equal(GENERIC_POOL_POWERGRYD_CLIENT_ID, 592842);
    assert.equal(GENERIC_POOL_POWERGRYD_CLIENT_ID, POWERGRYD_CLIENT_ID);
    assert.deepEqual([...GENERIC_POOL_CORE_KINDS], [
      "generic_idle",
      "generic_multi_client",
    ]);
    for (const kind of GENERIC_POOL_CORE_KINDS) {
      assert.ok(
        (CANON_CORE_KINDS as readonly string[]).includes(kind),
        `${kind} must flip canonCompliant`,
      );
    }
  });

  it("reads POD tags and provider families", () => {
    assert.equal(podFromMailboxTags([{ tag_name: "POD-A" }]), "A");
    assert.equal(podFromMailboxTags([{ name: "POD-B" }]), "B");
    assert.equal(
      podFromMailboxTags([{ tag_name: "POD-A" }, { tag_name: "POD-B" }]),
      null,
    );
    assert.equal(genericProviderFromAccountType("OUTLOOK"), "MICROSOFT");
    assert.equal(genericProviderFromAccountType("GMAIL"), "GOOGLE");
  });
});

describe("D221 validateGenericPool", () => {
  it("is quiet when assigned generics fill a short POD and no more", () => {
    const findings = validateGenericPool({
      seats: [
        seat("ada@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedCampaignIds: [10],
          assignedAt: "2026-10-01T00:00:00.000Z",
          reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
        }),
        seat("ben@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedCampaignIds: [10],
          assignedAt: "2026-10-01T00:00:00.000Z",
          reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
        }),
        seat("idle-pool@getintroduced.info", {
          assignedClientId: null,
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 38]]),
      clientHasActiveCampaign: new Map([[77, true]]),
      campaignClientById: new Map([[10, 77]]),
    });
    assert.deepEqual(findings, []);
    assert.equal(genericPoolCanonCompliant([]), true);
  });

  it("flags a generic assigned after the POD is already at 40", () => {
    const findings = validateGenericPool({
      seats: [
        seat("ada@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-01T00:00:00.000Z",
          reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 40]]),
      clientHasActiveCampaign: new Map([[77, true]]),
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, "generic_idle");
    assert.match(findings[0]!.detail, /ada@getintroduced\.info/);
    assert.match(findings[0]!.detail, /client 77 POD A/);
    assert.equal(
      genericPoolCanonCompliant(findings.map(genericPoolFindingLine)),
      false,
    );
  });

  it("flags only the surplus seats when named + assigned is above 40", () => {
    const seats = Array.from({ length: 8 }, (_, i) =>
      seat(`g${i}@getintroduced.info`, {
        assignedClientId: 77,
        assignedPod: "B",
        assignedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        reason: GENERIC_ASSIGN_REASON_POD_TOP_UP,
      }),
    );
    const findings = validateGenericPool({
      seats,
      namedStaffableByClientPod: new Map([[clientPodKey(77, "B"), 35]]),
      clientHasActiveCampaign: new Map([[77, true]]),
    });
    assert.equal(findings.length, 3);
    assert.ok(findings.every((row) => row.kind === "generic_idle"));
    const emails = findings.map((row) => row.email).sort();
    assert.deepEqual(emails, [
      "g5@getintroduced.info",
      "g6@getintroduced.info",
      "g7@getintroduced.info",
    ]);
  });

  it("tops each POD independently and does not move surplus across PODs", () => {
    const findings = validateGenericPool({
      seats: [
        seat("a1@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
        seat("a2@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
        seat("b-idle@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "B",
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
      namedStaffableByClientPod: new Map([
        [clientPodKey(77, "A"), 38],
        [clientPodKey(77, "B"), 40],
      ]),
      clientHasActiveCampaign: new Map([[77, true]]),
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.email, "b-idle@getintroduced.info");
    assert.match(findings[0]!.detail, /POD B/);
  });

  it("returns a generic when the client's campaigns are no longer ACTIVE", () => {
    const findings = validateGenericPool({
      seats: [
        seat("ada@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedCampaignIds: [10],
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 10]]),
      clientHasActiveCampaign: new Map([[77, false]]),
    });
    assert.equal(findings[0]!.kind, "generic_idle");
    assert.match(findings[0]!.detail, /no ACTIVE campaign/);
  });

  it("skips idle for PowerGRYD dedicated seats and the 24h TERRL substitute", () => {
    const findings = validateGenericPool({
      seats: [
        seat("pg@getintroduced.info", {
          assignedClientId: GENERIC_POOL_POWERGRYD_CLIENT_ID,
          assignedPod: "A",
          reason: GENERIC_ASSIGN_REASON_POWERGRYD,
        }),
        seat("swap@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          reason: GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE,
        }),
        seat("swap2@getintroduced.info", {
          assignedClientId: 88,
          assignedPod: "B",
          reason: GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE_ALIAS,
        }),
      ],
      namedStaffableByClientPod: new Map([
        [clientPodKey(GENERIC_POOL_POWERGRYD_CLIENT_ID, "A"), 40],
        [clientPodKey(77, "A"), 40],
        [clientPodKey(88, "B"), 40],
      ]),
      clientHasActiveCampaign: new Map([
        [GENERIC_POOL_POWERGRYD_CLIENT_ID, true],
        [77, true],
        [88, true],
      ]),
    });
    assert.deepEqual(findings, []);
  });

  it("fails when one generic is assigned to more than one client", () => {
    const findings = validateGenericPool({
      seats: [
        seat("ada@getintroduced.info", {
          assignedClientId: 77,
          assignedCampaignIds: [10, 20],
          assignedPod: "A",
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 30]]),
      campaignClientById: new Map([
        [10, 77],
        [20, 88],
      ]),
      liveClientIdsByEmail: new Map([["ada@getintroduced.info", [77, 88]]]),
      clientHasActiveCampaign: new Map([
        [77, true],
        [88, true],
      ]),
    });
    assert.ok(findings.some((row) => row.kind === "generic_multi_client"));
    const multi = findings.find((row) => row.kind === "generic_multi_client")!;
    assert.match(multi.detail, /77/);
    assert.match(multi.detail, /88/);
  });

  it("allows same-client multi-campaign links", () => {
    const findings = validateGenericPool({
      seats: [
        seat("ada@getintroduced.info", {
          assignedClientId: 77,
          assignedCampaignIds: [10, 11],
          assignedPod: "A",
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 39]]),
      campaignClientById: new Map([
        [10, 77],
        [11, 77],
      ]),
      liveClientIdsByEmail: new Map([["ada@getintroduced.info", [77]]]),
      clientHasActiveCampaign: new Map([[77, true]]),
    });
    assert.deepEqual(
      findings.filter((row) => row.kind === "generic_multi_client"),
      [],
    );
  });

  it("still flags multi-client on a PowerGRYD or TERRL seat", () => {
    const findings = validateGenericPool({
      seats: [
        seat("pg@getintroduced.info", {
          assignedClientId: GENERIC_POOL_POWERGRYD_CLIENT_ID,
          assignedCampaignIds: [1, 2],
          reason: GENERIC_ASSIGN_REASON_POWERGRYD,
        }),
      ],
      namedStaffableByClientPod: new Map(),
      campaignClientById: new Map([
        [1, GENERIC_POOL_POWERGRYD_CLIENT_ID],
        [2, 77],
      ]),
    });
    assert.equal(findings[0]!.kind, "generic_multi_client");
  });

  it("treats an unpodded assignment as idle when neither POD needs a generic", () => {
    const findings = validateGenericPool({
      seats: [
        seat("held@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: null,
          assignedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
      namedStaffableByClientPod: new Map([
        [clientPodKey(77, "A"), 40],
        [clientPodKey(77, "B"), 40],
      ]),
      clientHasActiveCampaign: new Map([[77, true]]),
    });
    assert.equal(findings[0]!.kind, "generic_idle");
    assert.match(findings[0]!.detail, /either POD/);
  });
});

describe("D221 syncGenericSeatsFromInventory", () => {
  const config = {
    extraGenericMailboxes: [],
    extraGenericDomains: ["getintroduced.info"],
    prewarmedDomains: [],
  };
  const state = {
    getPoolMailbox: () => undefined,
    isCopyCanary: () => false,
  };

  it("writes one row per generic and leaves named seats off the table", () => {
    const result = syncGenericSeatsFromInventory({
      existing: [],
      accounts: [
        {
          id: 1,
          email: "ada@getintroduced.info",
          type: "GMAIL",
          client_id: 77,
          campaign_ids: [10],
          tags: [{ tag_name: "POD-A" }, { tag_name: "GENERIC" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 2,
          email: "named@techevolution.com",
          type: "OUTLOOK",
          client_id: 77,
          campaign_ids: [10],
          tags: [{ tag_name: "POD-A" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
        {
          id: 3,
          email: "free@getintroduced.info",
          type: "OUTLOOK",
          client_id: null,
          campaign_ids: [],
          tags: [{ tag_name: "GENERIC" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
      config,
      state,
      now: new Date("2026-10-03T12:00:00.000Z"),
    });
    assert.deepEqual(
      result.seats.map((row) => row.email),
      ["ada@getintroduced.info", "free@getintroduced.info"],
    );
    const assigned = result.seats.find((row) => row.email.startsWith("ada"))!;
    assert.equal(assigned.assignedClientId, 77);
    assert.equal(assigned.assignedPod, "A");
    assert.deepEqual(assigned.assignedCampaignIds, [10]);
    assert.equal(assigned.reason, GENERIC_ASSIGN_REASON_POD_TOP_UP);
    assert.equal(assigned.provider, "GOOGLE");
    const free = result.seats.find((row) => row.email.startsWith("free"))!;
    assert.equal(free.assignedClientId, null);
    assert.equal(free.reason, null);
    assert.equal(
      result.namedStaffableByClientPod.get(clientPodKey(77, "A")),
      1,
    );
  });

  it("keeps an existing TERRL substitute reason across a same-client resync", () => {
    const result = syncGenericSeatsFromInventory({
      existing: [
        seat("swap@getintroduced.info", {
          slAccountId: 9,
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-02T00:00:00.000Z",
          reason: GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE,
        }),
      ],
      accounts: [
        {
          id: 9,
          email: "swap@getintroduced.info",
          type: "OUTLOOK",
          client_id: 77,
          campaign_ids: [10],
          tags: [{ tag_name: "POD-A" }],
          is_smtp_success: true,
          is_imap_success: true,
        },
      ],
      campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
      config,
      state,
    });
    assert.equal(result.seats[0]!.reason, GENERIC_ASSIGN_REASON_TERRL_SUBSTITUTE);
    assert.equal(result.seats[0]!.assignedAt, "2026-10-02T00:00:00.000Z");
  });
});
