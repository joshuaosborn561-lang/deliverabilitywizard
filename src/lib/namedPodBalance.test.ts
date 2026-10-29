import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NAMED_POD_MAX_GAP,
  namedPodGap,
  namedPodsBalanced,
  planNamedPodRebalance,
  type NamedPodEsp,
  type NamedPodSeat,
  type NamedPodSide,
} from "./namedPodBalance.js";

let n = 0;
function seat(
  pod: NamedPodSide,
  esp: NamedPodEsp = "gmail",
  over: Partial<NamedPodSeat> = {},
): NamedPodSeat {
  n += 1;
  return {
    accountId: n,
    email: `s${String(n).padStart(3, "0")}@x.com`,
    clientId: 1,
    pod,
    esp,
    onActiveCampaign: false,
    locked: false,
    ...over,
  };
}
const many = (k: number, pod: NamedPodSide, esp: NamedPodEsp = "gmail", over: Partial<NamedPodSeat> = {}) =>
  Array.from({ length: k }, () => seat(pod, esp, over));

describe("D316 named POD balance — 15%", () => {
  it("the cap is 15% of the larger POD", () => {
    assert.equal(NAMED_POD_MAX_GAP, 0.15);
    assert.equal(namedPodsBalanced(20, 17), true, "exactly 15% passes");
    assert.equal(namedPodsBalanced(20, 16), false);
    assert.equal(namedPodsBalanced(0, 0), true);
    assert.equal(namedPodGap(10, 10), 0);
  });

  it("a balanced client plans nothing", () => {
    const plan = planNamedPodRebalance([...many(10, "A"), ...many(9, "B")]);
    assert.equal(plan.moves.length, 0);
  });

  it("moves the fewest seats larger → smaller until within 15%", () => {
    const plan = planNamedPodRebalance([...many(30, "A"), ...many(10, "B")], { maxMoves: 50 });
    const a = 30 - plan.moves.filter((m) => m.from === "A").length;
    const b = 10 + plan.moves.length;
    assert.ok(plan.moves.every((m) => m.from === "A" && m.to === "B"));
    assert.ok(namedPodsBalanced(a, b), `${a}/${b} still outside 15%`);
    assert.equal(plan.moves.length, 9, "30/10 → 21/19 would be 9.5%; 22/18 is 18%; 21/19 needs 9 moves");
  });

  it("never moves a seat on an ACTIVE campaign, a locked seat, or a seat twice", () => {
    const attached = many(8, "A", "gmail", { onActiveCampaign: true });
    const locked = many(2, "A", "gmail", { locked: true });
    const idle = many(2, "A");
    const plan = planNamedPodRebalance([...attached, ...locked, ...idle, ...many(2, "B")], { maxMoves: 50 });
    const ids = plan.moves.map((m) => m.accountId);
    assert.deepEqual(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => idle.some((s) => s.accountId === id)), "only idle seats move");
    assert.ok(plan.moves.length <= 2);
    const rep = plan.clients[0]!;
    assert.ok(rep.remainingGap > NAMED_POD_MAX_GAP, "reports what it could not fix");
  });

  it("keeps each ESP balanced: takes the ESP the big POD holds the most extra of", () => {
    const seats = [
      ...many(10, "A", "outlook"),
      ...many(10, "A", "gmail"),
      ...many(8, "B", "outlook"),
      ...many(2, "B", "gmail"),
    ];
    const plan = planNamedPodRebalance(seats, { maxMoves: 50 });
    assert.ok(plan.moves.length > 0);
    assert.equal(plan.moves[0]!.esp, "gmail", "gmail is the ESP POD-A is long on");
  });

  it("caps moves per pass across all clients", () => {
    const seats = [
      ...many(40, "A", "gmail", { clientId: 1 }),
      ...many(40, "A", "gmail", { clientId: 2 }),
    ];
    const plan = planNamedPodRebalance(seats, { maxMoves: 10 });
    assert.equal(plan.moves.length, 10);
  });

  it("does not flip a tiny client back and forth (3/2 has no better split)", () => {
    const plan = planNamedPodRebalance([...many(3, "A"), ...many(2, "B")]);
    assert.equal(plan.moves.length, 0);
  });
});
