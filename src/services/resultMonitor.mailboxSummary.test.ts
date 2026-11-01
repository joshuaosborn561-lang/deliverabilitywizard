import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAllMailboxSummaryRows, MAILBOX_SUMMARY_PAGE } from "./resultMonitor.js";
import { normalizeMailboxSummary } from "../clients/smartdelivery.js";

describe("D303 mailboxes-summary paging", () => {
  it("pages limit/offset until every mailbox (2,151) is read", async () => {
    const total = 2151;
    const offsets: number[] = [];
    const rows = await readAllMailboxSummaryRows({
      getMailboxSummary: async () => [],
      getMailboxSummaryPage: async (limit, offset) => {
        offsets.push(offset);
        const n = Math.max(0, Math.min(limit, total - offset));
        return Array.from({ length: n }, (_, i) => ({ id: offset + i }) as never);
      },
    });
    assert.equal(rows.length, total);
    assert.equal(offsets[1], MAILBOX_SUMMARY_PAGE);
  });
  it("stops if the endpoint ignores offset", async () => {
    let calls = 0;
    const rows = await readAllMailboxSummaryRows({
      getMailboxSummary: async () => [],
      getMailboxSummaryPage: async (limit) => {
        calls += 1;
        return Array.from({ length: limit }, (_, i) => ({ id: i }) as never);
      },
    });
    assert.equal(calls, 2);
    assert.equal(rows.length, MAILBOX_SUMMARY_PAGE);
  });
  it("unwraps data/result wrappers", () => {
    assert.equal(normalizeMailboxSummary({ data: [{ id: 1 }] }).length, 1);
    assert.equal(normalizeMailboxSummary({ result: { mailboxes: [{ id: 1 }, { id: 2 }] } }).length, 2);
  });
});
