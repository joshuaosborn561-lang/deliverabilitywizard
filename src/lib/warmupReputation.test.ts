import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectWarmupReputationRotations,
  parseWarmupReputation,
  shouldRotateForWarmupReputation,
} from "./warmupReputation.js";

describe("parseWarmupReputation", () => {
  it("reads the percent-suffixed string the campaign route returns", () => {
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: "99%" } }), 99);
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: "61%" } }), 61);
  });

  it("reads a bare number", () => {
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: 77 } }), 77);
  });

  it("reads a real zero rather than discarding it", () => {
    // salesgliderfly.info mailboxes genuinely report 0% — a dead mailbox, not
    // a missing reading. Collapsing this to null would leave them on campaigns.
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: "0%" } }), 0);
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: 0 } }), 0);
  });

  it("returns null — never 0 — when there is no reading", () => {
    assert.equal(parseWarmupReputation({ warmup_details: {} }), null);
    assert.equal(parseWarmupReputation({ warmup_details: null }), null);
    assert.equal(parseWarmupReputation({}), null);
    assert.equal(parseWarmupReputation(null), null);
    assert.equal(parseWarmupReputation(undefined), null);
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: "" } }), null);
    assert.equal(parseWarmupReputation({ warmup_details: { warmup_reputation: "n/a" } }), null);
  });
});

describe("shouldRotateForWarmupReputation", () => {
  it("rotates the crossscaleco band", () => {
    for (const rep of [61, 66, 70, 77]) {
      assert.equal(shouldRotateForWarmupReputation(rep, 90), true, `rep ${rep}`);
    }
  });

  it("rotates a dead 0% mailbox", () => {
    assert.equal(shouldRotateForWarmupReputation(0, 90), true);
  });

  it("keeps healthy mailboxes", () => {
    for (const rep of [90, 93, 98, 99, 100]) {
      assert.equal(shouldRotateForWarmupReputation(rep, 90), false, `rep ${rep}`);
    }
  });

  it("treats the threshold itself as passing", () => {
    assert.equal(shouldRotateForWarmupReputation(90, 90), false);
    assert.equal(shouldRotateForWarmupReputation(89.9, 90), true);
  });

  it("never rotates on a missing reading", () => {
    assert.equal(shouldRotateForWarmupReputation(null, 90), false);
  });

  it("is disabled by a non-positive threshold", () => {
    assert.equal(shouldRotateForWarmupReputation(12, 0), false);
    assert.equal(shouldRotateForWarmupReputation(12, -1), false);
    assert.equal(shouldRotateForWarmupReputation(12, Number.NaN), false);
  });
});

describe("collectWarmupReputationRotations", () => {
  const fleet = [
    { from_email: "escobarb@crossscaleco.com", warmup_details: { warmup_reputation: "61%" } },
    { from_email: "breannae@crossscaleco.com", warmup_details: { warmup_reputation: "69%" } },
    { from_email: "joshuaosborn@salesgliderfly.info", warmup_details: { warmup_reputation: "0%" } },
    { from_email: "josborn@salesgliderbiz.org", warmup_details: { warmup_reputation: "100%" } },
    { from_email: "healthy@vasco.info", warmup_details: { warmup_reputation: "99%" } },
    { from_email: "unknown@x.com", warmup_details: {} },
  ];

  it("collects only the damaged senders", () => {
    const out = collectWarmupReputationRotations(fleet, 90);
    assert.deepEqual(
      [...out.keys()].sort(),
      [
        "breannae@crossscaleco.com",
        "escobarb@crossscaleco.com",
        "joshuaosborn@salesgliderfly.info",
      ],
    );
    assert.equal(out.get("escobarb@crossscaleco.com"), 61);
  });

  it("lowercases keys so lookups match the bounce map's convention", () => {
    const out = collectWarmupReputationRotations(
      [{ from_email: "  MiXeD@Crossscaleco.COM  ", warmup_details: { warmup_reputation: "61%" } }],
      90,
    );
    assert.ok(out.has("mixed@crossscaleco.com"));
  });

  it("returns an empty map when the signal is disabled", () => {
    assert.equal(collectWarmupReputationRotations(fleet, 0).size, 0);
  });

  it("skips accounts with no email", () => {
    const out = collectWarmupReputationRotations(
      [{ from_email: null, warmup_details: { warmup_reputation: "10%" } }],
      90,
    );
    assert.equal(out.size, 0);
  });
});
