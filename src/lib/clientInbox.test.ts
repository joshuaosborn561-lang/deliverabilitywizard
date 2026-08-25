import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClientInbox,
  isGenericMailbox,
  isRestEligibleMailbox,
} from "./clientInbox.js";

const fleet = {
  extraGenericMailboxes: ["harmony norris"],
  extraGenericDomains: ["crosslaunchco.com", "crossscaleco.com", "cleartechco.com"],
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
