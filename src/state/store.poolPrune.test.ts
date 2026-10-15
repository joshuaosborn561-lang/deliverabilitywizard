import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropGhostPoolSeats } from "../lib/poolInventoryReconcile.js";
import { StateStore } from "./store.js";

describe("D269 ghost pool prune persists on the sidecar", () => {
  it("stale dump cannot resurrect dropped pool seats after persistPoolPrune", async () => {
    const path = `/tmp/dw-pool-prune-hot-${process.pid}-${Date.now()}.json`;
    const stale = new StateStore(path);
    await stale.load();
    stale.upsertPoolMailbox({
      email: "ghost@nowgetintroduced.com",
      domain: "nowgetintroduced.com",
      platform: "GOOGLE",
      smartleadAccountId: 1,
      firstName: "Ghost",
      lastName: "Seat",
      status: "available",
      warmedAt: "2026-01-01T00:00:00.000Z",
    });
    stale.upsertPoolMailbox({
      email: "live@crosslaunchco.com",
      domain: "crosslaunchco.com",
      platform: "GOOGLE",
      smartleadAccountId: 2,
      firstName: "Live",
      lastName: "Seat",
      status: "assigned",
      warmedAt: "2026-01-01T00:00:00.000Z",
    });
    await stale.save();

    const live = new StateStore(path);
    await live.load();
    const dropped = dropGhostPoolSeats(
      live,
      new Set(["live@crosslaunchco.com"]),
    );
    assert.deepEqual(dropped, ["ghost@nowgetintroduced.com"]);
    await live.persistPoolPrune();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(
      reloaded.getPoolMailbox("ghost@nowgetintroduced.com"),
      undefined,
      "stale dump must not resurrect the ghost after sidecar prune",
    );
    assert.ok(
      reloaded.getPoolMailbox("live@crosslaunchco.com"),
      "living pool seats stay",
    );
    assert.ok(reloaded.listPoolGhostEmails().includes("ghost@nowgetintroduced.com"));
  });
});
