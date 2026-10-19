import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import {
  alreadyCoveredEmails,
  freeWarmGenericCount,
  isCornerstoneGenericDomain,
  isFreeWarmLedgerSeat,
  isInsightClientId,
  ledgerNoRestaffClientId,
  linkCoveringFor,
  pendingRetireDomains,
  pickCoveringForReturns,
  pickFreeWarmGenericsForPod,
  podShortNoFreeGeneric,
  seatCoveringReady,
  suppressPodFloorAlert,
  warmReadyAtFromClock,
} from "./genericLedger.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import {
  DEEP_ROOTS_CLIENT_ID,
  PETERSON_CLIENT_ID,
} from "./namedClientIds.js";
import { surplusGenericReturns } from "./genericSurplusReturn.js";
import { clientPodKey } from "./genericPool.js";

describe("D286 generics ledger helpers", () => {
  it("classifies CornerStone domains, Insight, and no-restaff clients", () => {
    assert.equal(
      isCornerstoneGenericDomain("ada@cornerstoneearthworksmy.info"),
      true,
    );
    assert.equal(isCornerstoneGenericDomain("ada@getintroduced.info"), false);
    assert.equal(isInsightClientId(INSIGHT_CLIENT_ID), true);
    assert.equal(isInsightClientId(592842), false);
    assert.equal(ledgerNoRestaffClientId(PETERSON_CLIENT_ID), true);
    assert.equal(ledgerNoRestaffClientId(DEEP_ROOTS_CLIENT_ID), true);
    assert.equal(ledgerNoRestaffClientId(592842), false);
  });

  it("links coveringFor to the soonest-warming uncovered branded seat", () => {
    const linked = linkCoveringFor({
      seat: emptyGenericSeat("gen@getintroduced.info", {
        assignedClientId: 77,
        assignedPod: "A",
      }),
      warming: [
        {
          email: "later@techevolution.com",
          clientId: 77,
          pod: "A",
          warmReadyAt: "2026-11-01T00:00:00.000Z",
        },
        {
          email: "soon@techevolution.com",
          clientId: 77,
          pod: "A",
          warmReadyAt: "2026-10-20T00:00:00.000Z",
        },
        {
          email: "otherpod@techevolution.com",
          clientId: 77,
          pod: "B",
          warmReadyAt: "2026-10-18T00:00:00.000Z",
        },
      ],
      alreadyCovered: [],
    });
    assert.deepEqual(linked, [
      { email: "soon@techevolution.com", warmReadyAt: "2026-10-20T00:00:00.000Z" },
    ]);
  });

  it("swaps the linked generic when coveringFor is ready and never drops below floor", () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    const ready = emptyGenericSeat("linked@getintroduced.info", {
      assignedClientId: 77,
      assignedPod: "A",
      assignedAt: "2026-10-01T00:00:00.000Z",
      coveringFor: [
        { email: "branded@techevolution.com", warmReadyAt: "2026-10-16T00:00:00.000Z" },
      ],
    });
    const unlinked = emptyGenericSeat("old@getintroduced.info", {
      assignedClientId: 77,
      assignedPod: "A",
      assignedAt: "2026-09-01T00:00:00.000Z",
    });
    const picked = pickCoveringForReturns({
      seats: [ready, unlinked],
      namedStaffable: 39,
      now,
    });
    assert.deepEqual(
      picked.map((row) => row.email),
      ["linked@getintroduced.info"],
    );
    assert.deepEqual(picked[0]!.attachBranded, ["branded@techevolution.com"]);
    assert.equal(picked[0]!.via, "covering_for");

    const blocked = pickCoveringForReturns({
      seats: [ready],
      namedStaffable: 38,
      now,
    });
    assert.equal(blocked.length, 0);
  });

  it("uses headcount only for unlinked seats in surplus return", () => {
    const weekday = new Date("2026-10-05T15:00:00.000Z");
    const picked = surplusGenericReturns({
      seats: [
        emptyGenericSeat("linked@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-01T00:00:00.000Z",
          coveringFor: [
            {
              email: "stillwarming@techevolution.com",
              warmReadyAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        }),
        emptyGenericSeat("unlinked@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 40]]),
      clientHasActiveCampaign: new Map([[77, true]]),
      now: weekday,
    });
    assert.deepEqual(
      picked.map((row) => row.email),
      ["unlinked@getintroduced.info"],
    );
    assert.equal(picked[0]!.via, "headcount");
  });

  it("flags a short POD with no free warm generic", () => {
    assert.equal(
      podShortNoFreeGeneric({
        namedStaffable: 30,
        assignedWeight: 2,
        freeWarm: 0,
        clientId: 77,
      }),
      true,
    );
    assert.equal(
      freeWarmGenericCount([
        emptyGenericSeat("free@getintroduced.info", { warmupEnabled: true }),
        emptyGenericSeat("off@getintroduced.info", { warmupEnabled: false }),
        emptyGenericSeat("busy@getintroduced.info", {
          assignedClientId: 77,
          warmupEnabled: true,
        }),
      ]),
      1,
    );
    assert.ok(seatCoveringReady({
      coveringFor: [{ email: "a@x.com", warmReadyAt: "2020-01-01T00:00:00.000Z" }],
    }).length);
    assert.ok(warmReadyAtFromClock("2026-10-01T00:00:00.000Z")?.startsWith("2026-10-22"));
    assert.equal(alreadyCoveredEmails([
      emptyGenericSeat("g@getintroduced.info", {
        coveringFor: [{ email: "n@x.com", warmReadyAt: null }],
      }),
    ]).has("n@x.com"), true);
  });

  it("D287: picks free warm generics, retire-pending last, never CornerStone", () => {
    const now = new Date("2026-10-19T16:00:00.000Z");
    const clean = emptyGenericSeat("ada@getintroduced.info", {
      warmupEnabled: true,
      warmReadyAt: "2026-09-01T00:00:00.000Z",
    });
    const retire = emptyGenericSeat("zoe@burned.info", {
      warmupEnabled: true,
      warmReadyAt: "2026-09-01T00:00:00.000Z",
    });
    const stone = emptyGenericSeat("owen@cornerstoneearthworksmy.info", {
      warmupEnabled: true,
    });
    const assigned = emptyGenericSeat("busy@getintroduced.info", {
      assignedClientId: 77,
      assignedPod: "A",
      warmupEnabled: true,
    });
    assert.equal(isFreeWarmLedgerSeat(clean, now), true);
    assert.equal(isFreeWarmLedgerSeat(stone, now), false);
    assert.equal(isFreeWarmLedgerSeat(assigned, now), false);
    const picked = pickFreeWarmGenericsForPod({
      seats: [retire, stone, assigned, clean],
      need: 2,
      retirePendingDomains: pendingRetireDomains({
        actions: [
          {
            kind: "retire_domain",
            status: "pending",
            detail: { domain: "burned.info" },
          },
        ],
      }),
      now,
    });
    assert.deepEqual(
      picked.map((row) => row.email),
      ["ada@getintroduced.info", "zoe@burned.info"],
    );
    assert.equal(suppressPodFloorAlert(PETERSON_CLIENT_ID), true);
    assert.equal(suppressPodFloorAlert(592842), false);
  });
});
