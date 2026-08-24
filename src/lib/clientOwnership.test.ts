import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  genericClientIdWhenIdle,
  genericIdentityClearFields,
  genericStillOnLiveCampaigns,
  isGenericForOwnership,
  isUntiedInfrastructureDomain,
  isWarmedForClientFloor,
  sendingDomainOf,
} from "./clientOwnership.js";

describe("client ownership helpers (D66)", () => {
  it("clears client_id on an idle generic", () => {
    assert.equal(genericClientIdWhenIdle(), null);
    assert.deepEqual(genericIdentityClearFields("Harmony", "Norris"), {
      signature: "Harmony Norris",
      from_name: "Harmony Norris",
      client_id: null,
    });
  });

  it("keeps a generic tied only while it is on an ACTIVE campaign", () => {
    const campaigns = new Map([
      [1, { status: "ACTIVE" }],
      [2, { status: "PAUSED" }],
    ]);
    assert.equal(genericStillOnLiveCampaigns([1], campaigns), true);
    assert.equal(genericStillOnLiveCampaigns([2], campaigns), false);
    assert.equal(genericStillOnLiveCampaigns([], campaigns), false);
  });

  it("treats fleet / canary / isolation domains as untied infrastructure", () => {
    assert.equal(
      isUntiedInfrastructureDomain("crosslaunchco.com", ["crosslaunchco.com"]),
      true,
    );
    assert.equal(
      isUntiedInfrastructureDomain("getcrosslaunchco.info", [], {
        copyCanaryDomains: ["getcrosslaunchco.info"],
      }),
      true,
    );
    assert.equal(
      isUntiedInfrastructureDomain("iso.test", [], { isolationDomain: "iso.test" }),
      true,
    );
    assert.equal(
      isUntiedInfrastructureDomain("boldercyperpartnerbiz.info", [
        "crosslaunchco.com",
      ]),
      false,
    );
  });

  it("does not count a mailbox toward the floor until it has warmed", () => {
    const now = new Date("2026-08-24T00:00:00Z");
    assert.equal(
      isWarmedForClientFloor("2026-08-24T00:00:00Z", 21, now),
      false,
    );
    assert.equal(
      isWarmedForClientFloor("2026-07-01T00:00:00Z", 21, now),
      true,
    );
    assert.equal(isWarmedForClientFloor(undefined, 21, now), true);
  });

  it("classifies pool generics as generic even with a leftover client_id", () => {
    assert.equal(sendingDomainOf("sandy@hubmeetconnect.com"), "hubmeetconnect.com");
    assert.equal(
      isGenericForOwnership(
        { client_id: 542838, from_name: "Sandy Koch" },
        "sandy@hubmeetconnect.com",
        { extraGenericMailboxes: [], extraGenericDomains: [] },
        {
          getPoolMailbox: () =>
            ({ email: "sandy@hubmeetconnect.com", status: "available" }) as never,
        },
      ),
      true,
    );
  });
});
