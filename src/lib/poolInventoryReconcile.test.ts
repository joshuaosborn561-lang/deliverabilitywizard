import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropGhostPoolSeats } from "./poolInventoryReconcile.js";

describe("dropGhostPoolSeats (D252)", () => {
  it("drops available/assigned seats missing from inventory and keeps warming", () => {
    const rows = new Map([
      [
        "ghost@nowgetintroduced.com",
        { email: "ghost@nowgetintroduced.com", status: "available" },
      ],
      [
        "live@crosslaunchco.com",
        { email: "live@crosslaunchco.com", status: "assigned" },
      ],
      [
        "new@crosslaunchco.com",
        { email: "new@crosslaunchco.com", status: "warming" },
      ],
    ]);
    const gone = new Set<string>();
    const dropped = dropGhostPoolSeats(
      {
        listPoolMailboxes: () => [...rows.values()],
        removePoolMailbox: (email) => {
          rows.delete(email);
        },
        recordPoolGhost: (email) => {
          gone.add(email);
        },
        forgetPoolGhost: (email) => {
          gone.delete(email);
        },
      },
      new Set(["live@crosslaunchco.com"]),
    );
    assert.deepEqual(dropped, ["ghost@nowgetintroduced.com"]);
    assert.equal(rows.has("ghost@nowgetintroduced.com"), false);
    assert.equal(rows.has("live@crosslaunchco.com"), true);
    assert.equal(rows.has("new@crosslaunchco.com"), true);
    assert.deepEqual([...gone], ["ghost@nowgetintroduced.com"]);
  });

  it("D269: a seat back in inventory is forgotten so the sidecar cannot delete it", () => {
    const gone = new Set(["live@crosslaunchco.com"]);
    dropGhostPoolSeats(
      {
        listPoolMailboxes: () => [
          { email: "live@crosslaunchco.com", status: "assigned" },
        ],
        removePoolMailbox: () => undefined,
        forgetPoolGhost: (email) => {
          gone.delete(email);
        },
      },
      new Set(["live@crosslaunchco.com"]),
    );
    assert.equal(gone.size, 0);
  });
});
