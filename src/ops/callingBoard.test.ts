import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCallingBoard } from "./callingBoard.js";

describe("calling board", () => {
  it("rolls a client into one card and flags the SOP misses", () => {
    const board = buildCallingBoard({
      snapshot: {
        updatedAt: "2026-11-04T18:00:00.000Z",
        partial: false,
        edgeLogs: "checked",
        gabeDialsYesterday: 212,
        gabeDialsTarget: null,
        tagging: { voicemailCalls: 10, voicemailTagged: 10, untaggedOver30s: 0 },
        suppression: { dnc: 4, dncStillQueued: 0, unsub: 6, unsubStillQueued: 1, unsubStillEmailed: 0 },
        numbers: [
          {
            clientName: "EMCOR",
            label: "Mesa",
            last4: "1857",
            daysSinceRotation: 3,
            spamLikely: false,
          },
        ],
        clients: [
          {
            clientName: "EMCOR",
            queueContacts: 136,
            queues: 1,
            queuesFull: 0,
            missingEmail: 2,
            queuesCalled3: 1,
            voicemailsYesterday: 8,
            emailsYesterday: 7,
            mismatchReason: "router timeout",
            routerErrors: 1,
            dncHookErrors: 0,
          },
        ],
      },
    });
    assert.equal(board.clients.length, 1);
    assert.equal(board.gabeDialsTarget, null);
    assert.equal(board.gabeDialsYesterday, 212);
    const card = board.clients[0]!;
    assert.equal(card.ok, false);
    assert.equal(card.buildNextList, true);
    assert.equal(card.bringToJosh, true);
    assert.ok(card.failures.some((row) => row.id === "missing-email"));
    assert.ok(card.failures.some((row) => row.text.includes("router timeout")));
  });

  it("does not invent a Gabe dial target", () => {
    const board = buildCallingBoard({ snapshot: null });
    assert.equal(board.gabeDialsTarget, null);
    assert.equal(board.gabeDialsYesterday, null);
  });
});
