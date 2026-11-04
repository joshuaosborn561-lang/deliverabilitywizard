import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NAMED_POD_MAX_GAP,
  NAMED_POD_MAX_MOVES_PER_PASS,
  genericNeedAfterNamedRebalance,
  namedPodGap,
  namedPodsBalanced,
  namedPodsEven,
  planNamedPodRebalance,
  projectNamedPods,
  seatMayMoveForNamedRebalance,
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

  it("never moves a locked seat or a seat twice", () => {
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

describe("D326 named POD rebalance — even split, off-week or idle", () => {
  it("BPLTG 21/59 becomes an even ESP-balanced split", () => {
    const plan = planNamedPodRebalance(
      [...many(21, "A", "gmail"), ...many(59, "B", "gmail")],
      { maxMoves: 50 },
    );
    assert.equal(plan.moves.length, 19);
    assert.ok(plan.moves.every((m) => m.from === "B" && m.to === "A"));
    assert.equal(namedPodsEven(21 + 19, 59 - 19), true);
    assert.equal(plan.clients[0]!.remainingGap, 0);
  });

  it("moves an off-week seat even when it still has an ACTIVE leftover link", () => {
    const offWeekLinked = many(8, "B", "gmail", {
      onActiveCampaign: true,
      offWeek: true,
    });
    const onWeekLive = many(2, "A", "gmail", { onActiveCampaign: true });
    const plan = planNamedPodRebalance([...onWeekLive, ...offWeekLinked], {
      maxMoves: 50,
    });
    assert.ok(plan.moves.length > 0);
    assert.ok(plan.moves.every((m) => offWeekLinked.some((s) => s.accountId === m.accountId)));
  });

  it("never moves an on-week seat that is linked to an ACTIVE campaign", () => {
    const onWeekLive = many(20, "A", "gmail", { onActiveCampaign: true });
    const offWeekIdle = many(2, "B");
    const plan = planNamedPodRebalance([...onWeekLive, ...offWeekIdle], {
      maxMoves: 50,
    });
    const ids = new Set(plan.moves.map((m) => m.accountId));
    assert.ok([...ids].every((id) => !onWeekLive.some((s) => s.accountId === id)));
  });

  it("keeps a 24h 5.7.233 / TERRL stop on its POD", () => {
    const held = many(10, "B", "outlook", { locked: true });
    const idle = many(2, "B");
    const thin = many(2, "A");
    const plan = planNamedPodRebalance([...thin, ...held, ...idle], {
      maxMoves: 50,
    });
    const ids = new Set(plan.moves.map((m) => m.accountId));
    assert.ok([...ids].every((id) => !held.some((s) => s.accountId === id)));
    assert.equal(seatMayMoveForNamedRebalance(held[0]!), false);
  });

  it("prefers rebalance over generics: 21/59 needs no pool top-up", () => {
    const need = genericNeedAfterNamedRebalance({
      namedA: 21,
      namedB: 59,
      movableA: 0,
      movableB: 59,
    });
    assert.deepEqual(need, {
      projectedA: 40,
      projectedB: 40,
      needA: 0,
      needB: 0,
    });
  });

  it("still tops a POD to 40 when the other POD cannot move enough named seats", () => {
    const need = genericNeedAfterNamedRebalance({
      namedA: 21,
      namedB: 59,
      movableA: 0,
      movableB: 0,
    });
    assert.equal(need.projectedA, 21);
    assert.equal(need.needA, 19);
    assert.equal(need.needB, 0);
  });

  it("one pass can even 21/59 (default cap 40)", () => {
    assert.ok(NAMED_POD_MAX_MOVES_PER_PASS >= 19);
    const projected = projectNamedPods({
      namedA: 21,
      namedB: 59,
      movableA: 0,
      movableB: 59,
    });
    assert.deepEqual(projected, { a: 40, b: 40, moves: 19 });
  });
});
