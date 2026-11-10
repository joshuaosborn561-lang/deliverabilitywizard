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
      now: new Date("2026-11-04T18:00:00.000Z"),
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

  const base = {
    updatedAt: "2026-11-10T19:00:00.000Z",
    partial: false,
    day: "2026-11-10",
    paceTarget: 1200,
    source: "campaign-watchdog-analytics" as const,
  };
  const now = new Date("2026-11-10T19:30:00.000Z");

  it("does not call a client with no lead reading a top-up (null is not 0)", () => {
    const board = buildWatchdogBoard({
      now,
      snapshot: {
        ...base,
        clients: [{ clientId: "1", clientName: "BPLTG", sendsToday: 700, leadsLeft: null, campaigns: 7, sendsRead: 7, leadsRead: 0 }],
      },
    });
    assert.equal(board.clients[0]?.status, "unread");
    assert.equal(board.needTopUp, 0);
    assert.equal(board.bringToJosh, 0);
  });

  it("a lead sum over only some campaigns is unread below the line, clear above it", () => {
    const board = buildWatchdogBoard({
      now,
      snapshot: {
        ...base,
        clients: [
          { clientId: "1", clientName: "Parlay", sendsToday: 900, leadsLeft: 1800, campaigns: 52, sendsRead: 52, leadsRead: 30 },
          { clientId: "2", clientName: "Emcor", sendsToday: 1300, leadsLeft: 9000, campaigns: 27, sendsRead: 27, leadsRead: 20 },
          { clientId: "3", clientName: "Goliath", sendsToday: 300, leadsLeft: 4100, campaigns: 12, sendsRead: 12, leadsRead: 12 },
        ],
      },
    });
    const by = new Map(board.clients.map((row) => [row.clientName, row.status]));
    assert.equal(by.get("Parlay"), "unread");
    assert.equal(by.get("Emcor"), "healthy");
    assert.equal(by.get("Goliath"), "topup");
    assert.equal(board.needTopUp, 1);
    assert.equal(board.partial, true);
  });

  it("does not show an earlier send day's sends as today", () => {
    const board = buildWatchdogBoard({
      now: new Date("2026-11-11T15:00:00.000Z"),
      snapshot: {
        ...base,
        clients: [{ clientId: "1", clientName: "Vector", sendsToday: 640, leadsLeft: 12000, campaigns: 3, sendsRead: 3, leadsRead: 3 }],
      },
    });
    assert.equal(board.clients[0]?.sendsToday, null);
    assert.equal(board.sendsToday, 0);
    assert.equal(board.clients[0]?.status, "unread");
    assert.equal(board.partial, true);
  });
});
