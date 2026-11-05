import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IsolationActionRecord } from "../state/isolationState.js";
import { buildFixQueue } from "./fixQueue.js";

function action(partial: Partial<IsolationActionRecord> & Pick<IsolationActionRecord, "id" | "kind" | "title">): IsolationActionRecord {
  return {
    status: "pending",
    proof: "proof",
    detail: {},
    allowed: "owner_or_operator",
    requestedAt: "2026-11-04T17:00:00.000Z",
    ...partial,
  };
}

describe("fix queue", () => {
  it("disables Approve on a copy change whose SpamAssassin score is not 0", () => {
    const queue = buildFixQueue({
      role: "owner",
      approvals: [
        {
          id: "spend-1",
          kind: "domain",
          description: "Vector domain",
          detail: {},
          requestedAt: "2026-11-04T17:00:00.000Z",
          status: "pending",
        },
      ],
      isolation: [
        action({
          id: "copy-clean",
          kind: "swap_copy",
          title: "Step 1 subject",
          detail: { campaignName: "Bolder", swap: "Quick note for the shop" },
        }),
        action({
          id: "copy-spam",
          kind: "swap_copy",
          title: "Opt-out line",
          detail: { campaignName: "Vector", swap: "Dear friend, this is guaranteed!" },
        }),
        action({
          id: "iso-1",
          kind: "retire_domain",
          title: "Domain example.test score 72",
          detail: { domain: "example.test" },
        }),
      ],
      checks: [
        {
          campaignId: 4,
          name: "Goliath | Example",
          firstSeenAt: "2026-11-04T17:00:00.000Z",
          firstCheckAt: null,
          firstPassedAt: null,
          lastSweepAt: "2026-11-04T17:00:00.000Z",
          lastKind: "hourly",
          findings: ["merge_tag_blank: blank {{company}} in step 3"],
          status: "ACTIVE",
        },
      ],
      audit: [],
    });
    assert.equal(queue.counts.approval, 1);
    assert.equal(queue.counts.copy, 2);
    assert.equal(queue.counts.isolation, 1);
    assert.equal(queue.counts.audit, 1);
    const clean = queue.items.find((item) => item.id === "copy:copy-clean");
    const spam = queue.items.find((item) => item.id === "copy:copy-spam");
    assert.equal(clean?.approveDisabled, false);
    assert.equal(clean?.spamAssassin?.score, 0);
    assert.equal(spam?.approveDisabled, true);
    assert.ok((spam?.spamAssassin?.score ?? 0) > 0);
  });

  it("hides an audit finding Cayden already rejected", () => {
    const queue = buildFixQueue({
      role: "operator",
      approvals: [],
      isolation: [],
      checks: [
        {
          campaignId: 4,
          name: "Goliath",
          firstSeenAt: "2026-11-04T17:00:00.000Z",
          firstCheckAt: null,
          firstPassedAt: null,
          lastSweepAt: null,
          lastKind: "hourly",
          findings: ["mailbox_sig: double signature in step 2"],
          status: "ACTIVE",
        },
      ],
      audit: [
        {
          id: "a1",
          at: "2026-11-04T17:00:00.000Z",
          actor: "cayden",
          role: "operator",
          action: "finding-reject",
          target: "audit:4:mailbox_sig",
          outcome: "success",
        },
      ],
    });
    assert.equal(queue.counts.audit, 0);
    assert.equal(queue.counts.approval, 0);
  });
  it("lists audit findings only for campaigns ACTIVE in the live book", () => {
    const base = {
      firstSeenAt: "2026-11-01T00:00:00.000Z",
      firstCheckAt: null,
      firstPassedAt: null,
      lastSweepAt: null,
      lastKind: "hourly" as const,
    };
    const queue = buildFixQueue({
      role: "owner",
      approvals: [],
      isolation: [],
      audit: [],
      statusById: new Map([
        [1, "ACTIVE"],
        [2, "PAUSED"],
      ]),
      checks: [
        { ...base, campaignId: 1, name: "Vector | Live", findings: ["mailbox_sig: a@x.info has no signature"] },
        { ...base, campaignId: 2, name: "Vector | Paused", findings: ["mailbox_sig: b@x.info has no signature"] },
        { ...base, campaignId: 3, name: "Vector | Deleted", findings: ["mailbox_sig: c@x.info has no signature"] },
      ],
    });
    assert.deepEqual(queue.items.map((item) => item.id), ["audit:1:mailbox_sig"]);
    assert.equal(queue.counts.audit, 1);
  });
});
