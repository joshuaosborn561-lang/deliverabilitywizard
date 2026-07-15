import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkArray, uniqueStrings } from "./http.js";
import { extractSenderEmails, pickSequence } from "../clients/smartlead.js";
import { asBlacklistRows, normalizeTestList } from "../clients/smartdelivery.js";

describe("chunkArray", () => {
  it("splits mailboxes into batches of at most 50", () => {
    const emails = Array.from({ length: 120 }, (_, i) => `user${i}@example.com`);
    const batches = chunkArray(emails, 50);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]!.length, 50);
    assert.equal(batches[1]!.length, 50);
    assert.equal(batches[2]!.length, 20);
  });

  it("keeps small lists as a single batch", () => {
    const batches = chunkArray(["a@x.com", "b@x.com"], 50);
    assert.deepEqual(batches, [["a@x.com", "b@x.com"]]);
  });
});

describe("uniqueStrings", () => {
  it("dedupes case-insensitively", () => {
    assert.deepEqual(uniqueStrings(["A@x.com", "a@x.com", " b@x.com ", ""]), [
      "A@x.com",
      "b@x.com",
    ]);
  });
});

describe("extractSenderEmails / pickSequence", () => {
  it("prefers from_email then email then username", () => {
    const emails = extractSenderEmails([
      { id: 1, from_email: "one@example.com" },
      { id: 2, email: "two@example.com" },
      { id: 3, username: "three@example.com" },
    ]);
    assert.deepEqual(emails, [
      "one@example.com",
      "two@example.com",
      "three@example.com",
    ]);
  });

  it("picks requested sequence number", () => {
    const seq = pickSequence(
      [
        { id: 10, seq_number: 1, subject: "First" },
        { id: 20, seq_number: 2, subject: "Second" },
      ],
      2,
    );
    assert.equal(seq?.id, 20);
  });
});

describe("SmartDelivery helpers", () => {
  it("normalizes test list payloads", () => {
    assert.equal(normalizeTestList([{ id: 1 }]).length, 1);
    assert.equal(normalizeTestList({ data: [{ id: 2 }] }).length, 1);
    assert.equal(normalizeTestList({}).length, 0);
  });

  it("normalizes blacklist payloads", () => {
    assert.equal(asBlacklistRows([{ domain: "a.com", total_blacklist: 1 }]).length, 1);
    assert.equal(asBlacklistRows({ result: [{ domain: "b.com" }] }).length, 1);
    assert.equal(asBlacklistRows({}).length, 0);
  });
});

describe("quota gate math", () => {
  it("blocks when needed tests exceed remaining quota", () => {
    const used = 110;
    const quota = 120;
    const mailboxCounts = [45, 60]; // -> 1 + 2 = 3 tests
    const needed = mailboxCounts
      .map((n) => Math.ceil(n / 50))
      .reduce((a, b) => a + b, 0);
    const remaining = Math.max(0, quota - used);
    assert.equal(needed, 3);
    assert.equal(remaining, 10);
    assert.equal(needed > remaining, false);

    const tightUsed = 118;
    assert.equal(needed > Math.max(0, quota - tightUsed), true);
  });
});
