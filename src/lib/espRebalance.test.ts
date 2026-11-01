import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planEspRebalance, type PodSeat, type SpareSeat } from "./espRebalance.js";

function pod(ms: number, gm: number, genericMs = 0): PodSeat[] {
  const out: PodSeat[] = [];
  for (let i = 0; i < ms; i += 1) out.push({ email: `m${i}@c.com`, esp: "outlook", generic: i < genericMs });
  for (let i = 0; i < gm; i += 1) out.push({ email: `g${i}@c.com`, esp: "gmail", generic: false });
  return out;
}

describe("D303 ESP auto-rebalance", () => {
  it("within tolerance does nothing", () => {
    const r = planEspRebalance({ clientId: 1, insight: false, microsoftShare: 0.5, pod: pod(20, 20), spares: [] });
    assert.equal(r.swaps.length, 0);
  });
  it("swaps 1-for-1 toward the share, generics out first, same-client branded in first", () => {
    const spares: SpareSeat[] = [
      { email: "free@g.com", esp: "gmail", generic: true, warm: true, clientId: null },
      { email: "own@c.com", esp: "gmail", generic: false, warm: true, clientId: 1 },
      { email: "other@d.com", esp: "gmail", generic: false, warm: true, clientId: 2 },
      { email: "cold@c.com", esp: "gmail", generic: false, warm: false, clientId: 1 },
    ];
    // 30 MS / 10 GM, target 0.5 → 20; tol 4 → need 10, only 2 eligible
    const r = planEspRebalance({ clientId: 1, insight: false, microsoftShare: 0.5, pod: pod(30, 10, 1), spares });
    assert.equal(r.swaps.length, 2);
    assert.equal(r.swaps[0]!.in.email, "own@c.com");
    assert.equal(r.swaps[0]!.out.generic, true);
    assert.ok(r.swaps.every((s) => s.in.email !== "other@d.com" && s.in.email !== "cold@c.com"));
    assert.match(r.reason, /short/);
  });
  it("Insight never receives generics", () => {
    const spares: SpareSeat[] = [{ email: "free@g.com", esp: "gmail", generic: true, warm: true, clientId: null }];
    const r = planEspRebalance({ clientId: 1, insight: true, microsoftShare: 0.5, pod: pod(30, 10), spares });
    assert.equal(r.swaps.length, 0);
  });
  it("a generic assigned to another client is never used", () => {
    const spares: SpareSeat[] = [{ email: "taken@g.com", esp: "gmail", generic: true, warm: true, clientId: 9 }];
    const r = planEspRebalance({ clientId: 1, insight: false, microsoftShare: 0.5, pod: pod(30, 10), spares });
    assert.equal(r.swaps.length, 0);
  });
  it("no InboxKit share means no change", () => {
    const r = planEspRebalance({ clientId: 1, insight: false, microsoftShare: undefined, pod: pod(30, 10), spares: [] });
    assert.equal(r.swaps.length, 0);
  });
});
