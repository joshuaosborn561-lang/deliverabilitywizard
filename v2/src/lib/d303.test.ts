import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mailboxCauseEmails,
  missingVariantTests,
  planEspFloorSwaps,
  sameEspInboxBySender,
  variantsFromSequenceRow,
} from "./d303.js";
import { duplicateCanaryTests } from "./isolation.js";
import { mailboxSummaryRows } from "../clients/smartdelivery.js";
import { INSIGHT_CLIENT_ID } from "../canon/constants.js";
import type { SlimAccount } from "../types.js";

function acct(id: number, email: string, extra: Partial<SlimAccount> = {}): SlimAccount {
  return {
    id, email, fromName: "", clientId: 5, campaignIds: [], tags: [], smtpOk: true, imapOk: true,
    messagePerDay: 30, warmupBlocked: false, createdAt: "2026-01-01T00:00:00Z", warmupStartedAt: "2026-01-01T00:00:00Z", signature: "",
    ...extra,
  };
}

describe("v2 D303", () => {
  it("parses variants and asks for placement + canary per extra variant", () => {
    const v = variantsFromSequenceRow({ seq_variants: [{ id: 1, variant_label: "A" }, { id: 2, variant_label: "B" }] });
    assert.deepEqual(v, [{ id: 1, label: "A" }, { id: 2, label: "B" }]);
    const miss = missingVariantTests({ campaignId: 9, campaignName: "C", variants: v, tests: [] });
    assert.deepEqual(miss.map((m) => [m.kind, m.label, m.mappingId]), [["placement", "B", 2], ["canary", "B", 2]]);
    const none = missingVariantTests({
      campaignId: 9, campaignName: "C", variants: v,
      tests: [{ id: "x", name: "Auto: C [variant B]" }, { id: "y", name: "Canary copy: #9 [variant B] C" }],
    });
    assert.equal(none.length, 0);
  });
  it("variant canaries are not duplicates of the primary", () => {
    const dup = duplicateCanaryTests([{ id: "1", name: "Canary copy: #9 C" }, { id: "2", name: "Canary copy: #9 [variant B] C" }], 9);
    assert.equal(dup.length, 1);
  });
  it("same-ESP per-sender reading finds mailboxes under 80%", () => {
    const r = sameEspInboxBySender({
      id: "t",
      senders: [
        { email: "a@x.com", inbox: false, provider: "outlook" },
        { email: "a@x.com", inbox: true, provider: "gmail" },
        { email: "b@x.com", inbox: true, provider: "outlook" },
      ],
    });
    assert.equal(r.get("a@x.com"), 0);
    assert.deepEqual(mailboxCauseEmails(r), ["a@x.com"]);
  });
  it("ESP floor swaps are 1-for-1, warm, same client, generics never for Insight", () => {
    const pod = [
      ...Array.from({ length: 9 }, (_, i) => acct(i + 1, `m${i}@x.com`, { campaignIds: [1] })),
      acct(50, "g@gmail.com", { campaignIds: [1] }),
    ];
    const spare = acct(60, "s@gmail.com");
    const other = acct(61, "o@gmail.com", { clientId: 6 });
    const gen = acct(62, "gen@gmail.com", { clientId: null });
    const generics = [{ accountId: 62, email: "gen@gmail.com", assignedClientId: null, assignedPod: null, assignedAt: null, releasedAt: null, reason: null }];
    const swaps = planEspFloorSwaps({ clientId: 5, pod, spares: [spare, other, gen], generics, warm: () => true });
    assert.equal(swaps.length, 2);
    assert.equal(swaps[0]!.in.email, "s@gmail.com");
    assert.ok(swaps.every((s) => s.in.email !== "o@gmail.com"));
    const insight = planEspFloorSwaps({ clientId: INSIGHT_CLIENT_ID, pod, spares: [gen], generics, warm: () => true });
    assert.equal(insight.length, 0);
  });
  it("mailbox summary rows unwrap", () => {
    assert.equal(mailboxSummaryRows({ data: [{ a: 1 }] }).length, 1);
  });
});
