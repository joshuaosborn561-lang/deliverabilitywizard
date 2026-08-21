import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isClientInbox } from "./clientInbox.js";

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
