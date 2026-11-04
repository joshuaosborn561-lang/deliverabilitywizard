import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWatchdogBoard } from "./watchdogBoard.js";

describe("watchdog board", () => {
  it("paces each client off mailbox caps and flags lead thresholds", () => {
    const board = buildWatchdogBoard({
      messagePerDay: 30,
      clients: [
        { id: 1, name: "Vector" },
        { id: 2, name: "Parlay" },
        { id: 3, name: "Bolder" },
      ],
      accounts: [
        {
          client_id: 1,
          type: "GMAIL",
          daily_sent_count: 30,
          campaigns: [{ status: "ACTIVE" }],
        },
        {
          client_id: 2,
          type: "OUTLOOK",
          daily_sent_count: 4,
          campaigns: [{ status: "ACTIVE" }],
        },
        {
          client_id: 3,
          type: "GMAIL",
          daily_sent_count: 30,
          campaigns: [{ status: "ACTIVE" }],
        },
      ],
      runway: [
        {
          campaignId: 10,
          name: "Vector",
          clientId: 1,
          remaining: 18000,
          total: 20000,
          recordedAt: "2026-11-04T17:00:00.000Z",
        },
        {
          campaignId: 11,
          name: "Parlay",
          clientId: 2,
          remaining: 4300,
          total: 9000,
          recordedAt: "2026-11-04T17:00:00.000Z",
        },
        {
          campaignId: 12,
          name: "Bolder",
          clientId: 3,
          remaining: 1500,
          total: 8000,
          recordedAt: "2026-11-04T17:00:00.000Z",
        },
      ],
    });
    assert.equal(board.paceLabel, "mailbox caps");
    assert.equal(board.clients.length, 3);
    const vector = board.clients.find((row) => row.clientName === "Vector");
    const parlay = board.clients.find((row) => row.clientName === "Parlay");
    const bolder = board.clients.find((row) => row.clientName === "Bolder");
    assert.equal(vector?.status, "healthy");
    assert.equal(vector?.target, 30);
    assert.equal(parlay?.status, "topup");
    assert.equal(parlay?.target, 15);
    assert.equal(bolder?.status, "josh");
    assert.equal(board.onPace, 2);
    assert.equal(board.needTopUp, 1);
    assert.equal(board.bringToJosh, 1);
    assert.equal(board.sendsToday, 64);
  });
});
