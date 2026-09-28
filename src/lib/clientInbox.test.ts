import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClientInbox,
  isGenericMailbox,
  isGenericPoolBrandDomain,
  isPoolGenericSeat,
  isRestEligibleMailbox,
} from "./clientInbox.js";

const fleet = {
  extraGenericMailboxes: ["harmony norris"],
  extraGenericDomains: ["crosslaunchco.com", "crossscaleco.com", "cleartechco.com"],
        prewarmedDomains: [],
};

describe("isClientInbox", () => {
  it("accepts a client-owned mailbox that is not a generic", () => {
    assert.equal(
      isClientInbox(
        { client_id: 9, from_name: "Josh" },
        "josh@boldercyperpartnerbiz.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
  });

  it("rejects pre-warmed fleet domains even with a client_id", () => {
    assert.equal(
      isClientInbox(
        { client_id: 9, from_name: "Harmony Norris" },
        "harmony@crosslaunchco.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
  });

  it("treats a GENERIC mailbox tag as a generic (D160)", () => {
    assert.equal(
      isGenericMailbox(
        {
          from_name: "Any Body",
          tags: [{ tag_name: "GENERIC" }],
        },
        "a@someclientdomain.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
    assert.equal(
      isClientInbox(
        {
          client_id: 9,
          from_name: "Any Body",
          tags: [{ tag_name: "GENERIC" }],
        },
        "a@someclientdomain.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
  });

  it("D193: getintroduced / quickconnect / appquickconnect hosts are generics", () => {
    assert.equal(isGenericPoolBrandDomain("trygetintroduced.info"), true);
    assert.equal(isGenericPoolBrandDomain("appquickconnectsales.com"), true);
    assert.equal(isGenericPoolBrandDomain("getquickconnectsales.info"), true);
    assert.equal(isGenericPoolBrandDomain("techevolution.com"), false);
    assert.equal(
      isPoolGenericSeat(
        {
          client_id: 521881,
          from_name: "Corey Tech",
          tags: [{ tag_name: "GENERIC" }],
        },
        "corey@techevolution.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
      "D200 — a leftover GENERIC tag does not make a named TechEvo domain exclusive-attach",
    );
    assert.equal(
      isPoolGenericSeat(
        {
          client_id: 521881,
          from_name: "Ada Pool",
          tags: [{ tag_name: "GENERIC" }],
        },
        "ada@trygetintroduced.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
      "D200 — pool-brand hosts stay exclusive-attach",
    );
    assert.equal(isGenericPoolBrandDomain("boldercyperpartnerhub.info"), false);
    assert.equal(
      isGenericMailbox(
        {
          client_id: 521881,
          from_name: "Pool Sender",
          tags: [{ tag_name: "GENERIC" }],
        },
        "ada@trygetintroduced.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
    assert.equal(
      isClientInbox(
        {
          client_id: 521881,
          from_name: "Pool Sender",
          tags: [{ tag_name: "GENERIC" }],
        },
        "ada@trygetintroduced.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
      "leftover TechEvo client_id does not make a pool brand a client inbox",
    );
  });

  it("rejects a dropped pool-plan domain as a generic (D76)", () => {
    assert.equal(
      isGenericMailbox(
        { from_name: "Claire Shah" },
        "claireshah@outreachdeskbox.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
  });

  it("rejects a pool-plan domain even with a leftover client_id (D76)", () => {
    assert.equal(
      isClientInbox(
        { client_id: 548610, from_name: "Aarav Sanchez" },
        "aaravsanchez@getoutreachdesk.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
    assert.equal(
      isGenericMailbox(
        { client_id: 548610, from_name: "Aarav Sanchez" },
        "aaravsanchez@getoutreachdesk.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
  });

  it("rejects pool generics", () => {
    assert.equal(
      isClientInbox(
        { client_id: 9, from_name: "Pool" },
        "spare@pool.info",
        fleet,
        {
          getPoolMailbox: () =>
            ({ email: "spare@pool.info", status: "available" }) as never,
        },
      ),
      false,
    );
  });

  it("D169: a client-named BCP domain is never a generic", () => {
    assert.equal(
      isGenericMailbox(
        {
          client_id: 542838,
          from_name: "Harmony Norris",
          tags: [{ tag_name: "GENERIC" }],
        },
        "alex@getboldercyperpartner.info",
        fleet,
        {
          getPoolMailbox: () =>
            ({ email: "alex@getboldercyperpartner.info", status: "assigned" }) as never,
          isMarkerClientId: () => true,
        },
      ),
      false,
      "boldercyper domains stay client inventory even with leftover generic marks",
    );
    assert.equal(
      isClientInbox(
        {
          client_id: 542838,
          from_name: "Harmony Norris",
          tags: [{ tag_name: "GENERIC" }],
        },
        "alex@getboldercyperpartner.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
  });

  it("D204: PowerGryd dedicated ids are named seats, not pool-generic", () => {
    const seat = {
      id: 21592105,
      client_id: 592842,
      from_name: "Ada Pool",
      tags: [{ tag_name: "GENERIC" }],
    };
    const email = "ada@trygetintroduced.info";
    assert.equal(
      isGenericMailbox(seat, email, fleet, { getPoolMailbox: () => undefined }),
      false,
      "mailbox id wins over pool-domain / GENERIC tag",
    );
    assert.equal(
      isPoolGenericSeat(seat, email, fleet, { getPoolMailbox: () => undefined }),
      false,
      "D200 one-campaign peel must not apply",
    );
    assert.equal(
      isClientInbox(seat, email, fleet, { getPoolMailbox: () => undefined }),
      true,
    );
    assert.equal(
      isRestEligibleMailbox(seat, email, fleet, { getPoolMailbox: () => undefined }),
      false,
      "no A/B rest for these 40",
    );
    assert.equal(
      isGenericMailbox(
        { ...seat, client_id: 542838 },
        email,
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
      "leftover Bolder client_id cannot make the seat a pool generic",
    );
  });

  it("rejects mailboxes with no client_id", () => {
    assert.equal(
      isClientInbox(
        { from_name: "Orphan" },
        "orphan@client.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
  });
});

describe("isRestEligibleMailbox", () => {
  it("is client inboxes only — generics use the send clock (D43)", () => {
    assert.equal(
      isRestEligibleMailbox(
        { client_id: 9, from_name: "Josh" },
        "josh@client.info",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      true,
    );
    assert.equal(
      isRestEligibleMailbox(
        { client_id: 9, from_name: "Harmony Norris" },
        "harmony@crosslaunchco.com",
        fleet,
        { getPoolMailbox: () => undefined },
      ),
      false,
    );
    assert.equal(
      isGenericMailbox(
        { from_name: "Pool" },
        "spare@pool.info",
        fleet,
        {
          getPoolMailbox: () =>
            ({ email: "spare@pool.info", status: "available" }) as never,
        },
      ),
      true,
    );
    assert.equal(
      isRestEligibleMailbox(
        { from_name: "Pool" },
        "spare@pool.info",
        fleet,
        {
          getPoolMailbox: () =>
            ({ email: "spare@pool.info", status: "available" }) as never,
        },
      ),
      false,
    );
  });
});
