import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dedicatedGenericClientId,
  isDedicatedToClient,
  isRealNamedClientId,
} from "./dedicatedGeneric.js";

const emptyState = { getPoolMailbox: () => undefined };

describe("dedicatedGenericClientId (D198)", () => {
  it("treats a named-client mailbox client_id as dedicated", () => {
    assert.equal(
      dedicatedGenericClientId(
        { client_id: 77 },
        "ada@trygetintroduced.info",
        emptyState,
        { genericOwnerId: 548611 },
      ),
      77,
    );
    assert.equal(
      isDedicatedToClient(
        { client_id: 77 },
        "ada@trygetintroduced.info",
        77,
        emptyState,
        { genericOwnerId: 548611 },
      ),
      true,
    );
  });

  it("prefers pool assignedClientId over a leftover mailbox client_id", () => {
    assert.equal(
      dedicatedGenericClientId(
        { client_id: 99 },
        "ada@trygetintroduced.info",
        {
          getPoolMailbox: () => ({ assignedClientId: 77 }),
        },
        { genericOwnerId: 548611 },
      ),
      77,
    );
  });

  it("reads a client:<id> mailbox tag", () => {
    assert.equal(
      dedicatedGenericClientId(
        { tags: [{ tag_name: "GENERIC" }, { tag_name: "client:521881" }] },
        "ada@trygetintroduced.info",
        emptyState,
        { genericOwnerId: 548611 },
      ),
      521881,
    );
  });

  it("does not treat the POC / Goliath owner as a named-client dedication", () => {
    assert.equal(
      dedicatedGenericClientId(
        { client_id: 548611 },
        "aarav@getoutreachdesk.info",
        emptyState,
        { genericOwnerId: 548611 },
      ),
      null,
    );
    assert.equal(
      dedicatedGenericClientId(
        { client_id: null },
        "spare@pool.info",
        {
          getPoolMailbox: () => ({ assignedClientId: 548611 }),
        },
        { genericOwnerId: 548611 },
      ),
      null,
    );
  });

  it("ignores marker Generic/POC ids", () => {
    assert.equal(
      isRealNamedClientId(900001, (id) => id === 900001),
      false,
    );
    assert.equal(
      dedicatedGenericClientId(
        { client_id: 900001 },
        "ada@trygetintroduced.info",
        { getPoolMailbox: () => undefined, isMarkerClientId: (id) => id === 900001 },
        { genericOwnerId: 548611 },
      ),
      null,
    );
  });

  it("returns null when there is no dedicated mark (rotating pool)", () => {
    assert.equal(
      dedicatedGenericClientId(
        { client_id: null, tags: [{ tag_name: "GENERIC" }] },
        "spare@pool.info",
        emptyState,
        { genericOwnerId: 548611 },
      ),
      null,
    );
  });
});
