import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientPodKey, emptyGenericSeat } from "./genericPool.js";
import {
  openTerlSubstituteEmails,
  returningWouldDropPodBelow40,
  surplusGenericReturns,
} from "./genericSurplusReturn.js";

const WEEKDAY = new Date("2026-10-05T15:00:00.000Z");
const WEEKEND = new Date("2026-10-03T15:00:00.000Z");

function seat(
  email: string,
  extras: Parameters<typeof emptyGenericSeat>[1] = {},
) {
  return emptyGenericSeat(email, extras);
}

describe("D225 surplus generic return picker", () => {
  it("returns extras once named + assigned is above 40", () => {
    const seats = Array.from({ length: 6 }, (_, i) =>
      seat(`g${i}@getintroduced.info`, {
        assignedClientId: 77,
        assignedPod: "A",
        assignedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        reason: "pod_top_up",
      }),
    );
    const picked = surplusGenericReturns({
      seats,
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 38]]),
      clientHasActiveCampaign: new Map([[77, true]]),
      now: WEEKDAY,
    });
    assert.equal(picked.length, 4);
    assert.ok(picked.every((row) => row.clientId === 77));
  });

  it("skips PowerGRYD and an active 24h TERRL substitute", () => {
    const picked = surplusGenericReturns({
      seats: [
        seat("pg@getintroduced.info", {
          assignedClientId: 592842,
          assignedPod: "A",
          reason: "powergryd_dedicated",
        }),
        seat("swap@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          reason: "terrl_substitute",
        }),
        seat("extra@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          assignedAt: "2026-10-02T00:00:00.000Z",
          reason: "pod_top_up",
        }),
      ],
      namedStaffableByClientPod: new Map([
        [clientPodKey(592842, "A"), 40],
        [clientPodKey(77, "A"), 40],
      ]),
      clientHasActiveCampaign: new Map([
        [592842, true],
        [77, true],
      ]),
      skipEmails: openTerlSubstituteEmails(
        [
          {
            substituteEmail: "swap@getintroduced.info",
            restoreAfter: "2026-10-06T15:00:00.000Z",
          },
        ],
        WEEKDAY,
      ),
      now: WEEKDAY,
    });
    assert.deepEqual(
      picked.map((row) => row.email),
      ["extra@getintroduced.info"],
    );
  });

  it("does nothing on a Chicago weekend", () => {
    const picked = surplusGenericReturns({
      seats: [
        seat("extra@getintroduced.info", {
          assignedClientId: 77,
          assignedPod: "A",
          reason: "pod_top_up",
        }),
      ],
      namedStaffableByClientPod: new Map([[clientPodKey(77, "A"), 40]]),
      clientHasActiveCampaign: new Map([[77, true]]),
      now: WEEKEND,
    });
    assert.deepEqual(picked, []);
  });

  it("never reports a return that would leave the POD under 40", () => {
    assert.equal(returningWouldDropPodBelow40(38, 1), true);
    assert.equal(returningWouldDropPodBelow40(38, 2), false);
    assert.equal(returningWouldDropPodBelow40(40, 0), false);
  });

  it("D228: does not pick a needed off-week POD when the on-week POD is already at 40", () => {
    const seats = [
      ...Array.from({ length: 4 }, (_, i) =>
        seat(`b${i}@getintroduced.info`, {
          assignedClientId: 77,
          assignedPod: "B",
          assignedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
          reason: "pod_top_up",
        }),
      ),
      seat("extra-a@getintroduced.info", {
        assignedClientId: 77,
        assignedPod: "A",
        assignedAt: "2026-10-02T00:00:00.000Z",
        reason: "pod_top_up",
      }),
    ];
    const picked = surplusGenericReturns({
      seats,
      namedStaffableByClientPod: new Map([
        [clientPodKey(77, "A"), 40],
        [clientPodKey(77, "B"), 36],
      ]),
      clientHasActiveCampaign: new Map([[77, true]]),
      now: WEEKDAY,
    });
    assert.deepEqual(
      picked.map((row) => row.email),
      ["extra-a@getintroduced.info"],
    );
  });
});
