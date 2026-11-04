import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLinkedInBoard, laneTone } from "./linkedinBoard.js";

describe("linkedin board", () => {
  it("greens 30–35, ambers a reason, and reds a broken day", () => {
    assert.deepEqual(
      laneTone(
        { label: "Josh", sentToday: 33, trend: [32, 34, 33], pending: 10, status: "IN_PROGRESS", reason: null },
        "ok",
      ),
      { tone: "green", reason: null },
    );
    assert.equal(
      laneTone(
        {
          label: "Randy",
          sentToday: 0,
          trend: [31, 12, 0],
          pending: 0,
          status: "IN_PROGRESS",
          reason: "out of leads",
        },
        "ok",
      ).tone,
      "red",
    );
    const board = buildLinkedInBoard({
      snapshot: {
        updatedAt: "2026-11-04T18:00:00.000Z",
        partial: false,
        repliesToday: 6,
        clients: [
          {
            clientName: "Parlay",
            checked: true,
            keyState: "ok",
            lanes: [
              {
                label: "Randy",
                sentToday: 19,
                trend: [40, 36, 19],
                pending: 40,
                status: "IN_PROGRESS",
                reason: "most prospects inactive",
              },
            ],
          },
          {
            clientName: "PowerGRYD",
            checked: false,
            keyState: "missing",
            lanes: [],
          },
          {
            clientName: "Nutter",
            checked: false,
            keyState: "invalid",
            lanes: [],
          },
        ],
      },
    });
    assert.equal(board.onTarget, 0);
    assert.equal(board.low, 1);
    assert.equal(board.unchecked, 2);
    assert.equal(board.repliesToday, 6);
    assert.equal(board.clients.find((row) => row.clientName === "PowerGRYD")?.reason, "no HeyReach key");
    assert.equal(board.clients.find((row) => row.clientName === "Nutter")?.reason, "HeyReach key is invalid");
    assert.equal(board.clients.find((row) => row.clientName === "Parlay")?.ok, false);
  });
});
