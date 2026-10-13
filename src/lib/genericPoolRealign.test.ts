import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { realignStalePoolAssignment } from "./genericPoolRealign.js";

describe("D258 realignStalePoolAssignment", () => {
  it("rewrites a stale PowerGRYD pool row to the live Smartlead client", async () => {
    const state = new StateStore(
      `/tmp/pool-realign-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "andreaadams@myoutreachdesk.info",
      domain: "myoutreachdesk.info",
      platform: "GOOGLE",
      smartleadAccountId: 11,
      firstName: "Andrea",
      lastName: "Adams",
      status: "assigned",
      assignedClientId: 592842,
      assignedClientName: "PowerGRYD",
      warmedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(
      realignStalePoolAssignment(state, "andreaadams@myoutreachdesk.info", 521881),
      true,
    );
    assert.equal(
      state.getPoolMailbox("andreaadams@myoutreachdesk.info")?.assignedClientId,
      521881,
    );
    assert.equal(
      realignStalePoolAssignment(state, "andreaadams@myoutreachdesk.info", 521881),
      false,
    );
  });

  it("does not clear a pool assignment when Smartlead client_id is empty", async () => {
    const state = new StateStore(
      `/tmp/pool-realign-empty-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "spare@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 12,
      firstName: "Ada",
      lastName: "Pool",
      status: "assigned",
      assignedClientId: 77,
      warmedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(
      realignStalePoolAssignment(state, "spare@getintroduced.info", null),
      false,
    );
    assert.equal(
      state.getPoolMailbox("spare@getintroduced.info")?.assignedClientId,
      77,
    );
  });
});
