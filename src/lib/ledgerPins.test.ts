import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import { applyLedgerPins, type LedgerPin } from "./ledgerPins.js";

const pin = (email: string): LedgerPin => ({
  email, clientId: 7, pod: "B", warmReadyAt: "2026-11-05T00:00:00.000Z",
  assignedAt: "2026-10-22T16:00:00.000Z", reason: "pod_top_up",
});
const seat = (email: string, clientId: number | null, pod: "A" | "B" | null) =>
  emptyGenericSeat(email, { assignedClientId: clientId, assignedPod: pod } as never);
const warming = Array.from({ length: 14 }, (_, i) => ({
  email: `n${String(i).padStart(2, "0")}@c.test`, clientId: 7, pod: "B" as const, warmReadyAt: null,
}));

describe("D299 ledger pins", () => {
  it("splits the POD's 14 warming seats across the 3 pins, idempotently", () => {
    const pins = ["g1@x.test", "g2@x.test", "g3@x.test"].map(pin);
    const other = seat("o@x.test", 7, "B");
    other.coveringFor = [{ email: "n00@c.test", warmReadyAt: null }];
    const seats = [seat("g1@x.test", 7, "B"), seat("g2@x.test", 7, "B"), seat("g3@x.test", 7, "B"), other];
    assert.equal(applyLedgerPins(seats, warming, pins), 3);
    const first = JSON.stringify(seats);
    applyLedgerPins(seats, warming, pins);
    assert.equal(JSON.stringify(seats), first);
    const covered = seats.slice(0, 3).flatMap((s) => s.coveringFor.map((c) => c.email));
    assert.equal(covered.length, 14);
    assert.equal(new Set(covered).size, 14);
    assert.equal(other.coveringFor.length, 0);
    assert.ok(seats[0]!.coveringFor.every((c) => c.warmReadyAt === "2026-11-05T00:00:00.000Z"));
    assert.equal(seats[0]!.reason, "pod_top_up");
    assert.equal(seats[0]!.assignedAt, "2026-10-22T16:00:00.000Z");
  });

  it("does nothing when the seat left that client/POD or nothing is warming", () => {
    const seats = [seat("g1@x.test", null, null), seat("g2@x.test", 7, "A")];
    assert.equal(applyLedgerPins(seats, warming, ["g1@x.test", "g2@x.test"].map(pin)), 0);
    const s3 = [seat("g3@x.test", 7, "B")];
    assert.equal(applyLedgerPins(s3, [], [pin("g3@x.test")]), 0);
    assert.equal(s3[0]!.coveringFor.length, 0);
  });
});
