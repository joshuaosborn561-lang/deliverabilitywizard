import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropGhostPoolSeats } from "./poolInventoryReconcile.js";

describe("dropGhostPoolSeats (D251)", () => {
  it("drops available/assigned seats missing from inventory and keeps warming", () => {
    const rows = new Map([
      [
        "ghost@nowgetintroduced.com",
        {
          email: "ghost@nowgetintroduced.com",
          domain: "nowgetintroduced.com",
          platform: "GOOGLE" as const,
          status: "available",
          smartleadAccountId: 9,
        },
      ],
      [
        "live@crosslaunchco.com",
        {
          email: "live@crosslaunchco.com",
          domain: "crosslaunchco.com",
          platform: "GOOGLE" as const,
          status: "assigned",
          smartleadAccountId: 8,
        },
      ],
      [
        "new@crosslaunchco.com",
        {
          email: "new@crosslaunchco.com",
          domain: "crosslaunchco.com",
          platform: "MICROSOFT" as const,
          status: "warming",
        },
      ],
    ]);
    const dropped = dropGhostPoolSeats(
      {
        listPoolMailboxes: () => [...rows.values()],
        removePoolMailbox: (email) => {
          rows.delete(email);
        },
      },
      new Set(["live@crosslaunchco.com"]),
    );
    assert.deepEqual(dropped, ["ghost@nowgetintroduced.com"]);
    assert.equal(rows.has("ghost@nowgetintroduced.com"), false);
    assert.equal(rows.has("live@crosslaunchco.com"), true);
    assert.equal(rows.has("new@crosslaunchco.com"), true);
  });
});
