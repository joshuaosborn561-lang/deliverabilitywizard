import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientMicrosoftShares } from "./inboxkitShare.js";
import { planEspFloorSwaps } from "./d303.js";
import type { SlimAccount } from "../types.js";

function acct(id: number, email: string, extra: Partial<SlimAccount> = {}): SlimAccount {
  return {
    id, email, fromName: "", clientId: 5, campaignIds: [], tags: [], smtpOk: true, imapOk: true,
    messagePerDay: 30, warmupBlocked: false, createdAt: null, warmupStartedAt: null, signature: "",
    ...extra,
  };
}

describe("v2 D303 InboxKit share (data-driven)", () => {
  it("counts each client's live InboxKit seats by platform via email join", () => {
    const accounts = [acct(1, "a@x.com"), acct(2, "b@x.com"), acct(3, "c@x.com"), acct(4, "d@y.com", { clientId: 6 })];
    const shares = clientMicrosoftShares(
      [
        { email: "a@x.com", status: "active", platform: "MICROSOFT" },
        { email: "b@x.com", status: "active", platform: "GOOGLE" },
        { email: "c@x.com", status: "cancelled", platform: "MICROSOFT" },
        { email: "zz@q.com", status: "active", platform: "MICROSOFT" },
      ],
      accounts,
      new Date("2026-10-26T12:00:00Z"),
    );
    assert.equal(shares.get(5), 0.5);
    assert.equal(shares.has(6), false);
  });
  it("planner targets the share when present, 1/3 floor otherwise", () => {
    const pod = [
      ...Array.from({ length: 6 }, (_, i) => acct(i + 1, `m${i}@x.com`, { campaignIds: [1] })),
      ...Array.from({ length: 14 }, (_, i) => acct(100 + i, `g${i}@gmail.com`, { campaignIds: [1] })),
    ];
    const spares = Array.from({ length: 10 }, (_, i) => acct(200 + i, `s${i}@x.com`));
    // MS 6/20 ≥ 1/3? 6 < 6.67 → floor wants 1; share 0.6 → target 12, tol 2 → 6 swaps
    assert.equal(planEspFloorSwaps({ clientId: 5, pod, spares, generics: [], warm: () => true }).length, 1);
    const withShare = planEspFloorSwaps({ clientId: 5, pod, spares, generics: [], warm: () => true, microsoftShare: 0.6 });
    assert.equal(withShare.length, 6);
    assert.ok(withShare.every((s) => s.out.email.endsWith("gmail.com")));
  });
});
