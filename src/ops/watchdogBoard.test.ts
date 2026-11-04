import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWatchdogBoard } from "./watchdogBoard.js";

describe("watchdog board", () => {
  it("uses the campaign-watchdog snapshot, not mailbox caps", () => {
    const board = buildWatchdogBoard({
      snapshot: {
        updatedAt: "2026-11-04T18:00:00.000Z",
        partial: false,
        day: "2026-11-04",
        paceTarget: 1200,
        source: "campaign-watchdog-analytics",
        clients: [
          { clientId: "1", clientName: "Vector", sendsToday: 1300, leadsLeft: 18000 },
          { clientId: "2", clientName: "Parlay", sendsToday: 820, leadsLeft: 9200 },
          { clientId: "3", clientName: "PowerGRYD", sendsToday: 1210, leadsLeft: 4300 },
          { clientId: "4", clientName: "Bolder", sendsToday: 400, leadsLeft: 1500 },
        ],
      },
    });
    assert.equal(board.paceLabel, "1,200/day");
    assert.equal(board.updatedAt, "2026-11-04T18:00:00.000Z");
    assert.equal(board.sendsToday, 3730);
    assert.equal(board.onPace, 2);
    assert.equal(board.tracked, 4);
    assert.equal(board.needTopUp, 1);
    assert.equal(board.bringToJosh, 1);
    assert.equal(board.clients.find((row) => row.clientName === "Parlay")?.status, "behind");
    assert.equal(board.clients.find((row) => row.clientName === "PowerGRYD")?.status, "topup");
    assert.equal(board.clients.find((row) => row.clientName === "Bolder")?.status, "josh");
  });

  it("stays empty until the hourly reading exists", () => {
    const board = buildWatchdogBoard({ snapshot: null });
    assert.equal(board.clients.length, 0);
    assert.equal(board.updatedAt, null);
    assert.equal(board.sendsToday, 0);
  });
});
