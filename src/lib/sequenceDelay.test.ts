import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmartleadSequence } from "../types/index.js";
import {
  STEP1_DELAY_DAYS,
  STEP2_DELAY_DAYS,
  campaignHasStep2DelayRule,
  ensureStep2Delay,
  formatStep2DelayFinding,
  sequenceDelayDays,
  sequenceStep2,
  step2NeedsDelayFix,
} from "./sequenceDelay.js";

const step1: SmartleadSequence = {
  id: 1,
  seq_number: 1,
  email_body: "<div>first</div>",
  seq_delay_details: { delay_in_days: 0, delayInDays: 0 },
};
const step2Wrong: SmartleadSequence = {
  id: 2,
  seq_number: 2,
  email_body: "<div>second</div>",
  seq_delay_details: { delay_in_days: 1, delayInDays: 1 },
};
const step2Ok: SmartleadSequence = {
  id: 2,
  seq_number: 2,
  email_body: "<div>second</div>",
  seq_delay_details: { delay_in_days: 2, delayInDays: 2 },
};
const step3: SmartleadSequence = {
  id: 3,
  seq_number: 3,
  email_body: "<div>third</div>",
  seq_delay_details: { delay_in_days: 4, delayInDays: 4 },
};

describe("sequenceDelay (D186)", () => {
  it("reads delay_in_days ahead of delayInDays", () => {
    assert.equal(STEP1_DELAY_DAYS, 0);
    assert.equal(STEP2_DELAY_DAYS, 2);
    assert.equal(
      sequenceDelayDays({ seq_delay_details: { delay_in_days: 2, delayInDays: 9 } }),
      2,
    );
    assert.equal(sequenceDelayDays({ seq_delay_details: { delayInDays: 2 } }), 2);
    assert.equal(sequenceDelayDays({ seq_delay_details: { delay_in_days: "2" } }), 2);
    assert.equal(sequenceDelayDays({ seq_delay_details: {} }), null);
    assert.equal(sequenceDelayDays(null), null);
  });

  it("finds seq_number 2 and skips 1-step campaigns", () => {
    assert.equal(sequenceStep2([step1, step2Ok, step3])?.id, 2);
    assert.equal(sequenceStep2([step1]), undefined);
    assert.equal(step2NeedsDelayFix([step1]), false);
    assert.equal(step2NeedsDelayFix([step1, step2Ok, step3]), false);
    assert.equal(step2NeedsDelayFix([step1, step2Wrong, step3]), true);
    assert.equal(formatStep2DelayFinding([step1, step2Wrong]), "step 2 delay 1d (want 2)");
    assert.equal(formatStep2DelayFinding([step1, step2Ok]), null);
    assert.equal(
      formatStep2DelayFinding([
        step1,
        { ...step2Wrong, seq_delay_details: undefined },
      ]),
      "step 2 delay unset (want 2)",
    );
  });

  it("writes only step 2; step 1 and step 3+ stay put", () => {
    const { sequences, changed } = ensureStep2Delay([step1, step2Wrong, step3]);
    assert.equal(changed, true);
    assert.deepEqual(sequences[0], step1);
    assert.deepEqual(sequences[0]!.seq_delay_details, {
      delay_in_days: 0,
      delayInDays: 0,
    });
    assert.equal(sequences[1]!.email_body, "<div>second</div>");
    assert.deepEqual(sequences[1]!.seq_delay_details, {
      delay_in_days: 2,
      delayInDays: 2,
    });
    assert.deepEqual(sequences[2], step3);
    assert.deepEqual(sequences[2]!.seq_delay_details, {
      delay_in_days: 4,
      delayInDays: 4,
    });
  });

  it("is a no-op when step 2 is already 2", () => {
    const input = [step1, step2Ok, step3];
    const { sequences, changed } = ensureStep2Delay(input);
    assert.equal(changed, false);
    assert.equal(sequences, input);
  });

  it("skips canary / pod-control / word-hunt shells", () => {
    assert.equal(
      campaignHasStep2DelayRule({ id: 1, name: "Goliath Education Receipts" }),
      true,
    );
    assert.equal(
      campaignHasStep2DelayRule({ id: 2, name: "Canary shell: #4 Live A" }),
      false,
    );
    assert.equal(
      campaignHasStep2DelayRule({ id: 3, name: "Pod control shell" }),
      false,
    );
    assert.equal(
      campaignHasStep2DelayRule({ id: 4, name: "DW Word Hunt Shell" }),
      false,
    );
  });
});
