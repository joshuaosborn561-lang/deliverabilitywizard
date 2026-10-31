import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmartleadSequence } from "../types/index.js";
import {
  STEP3_DELAY_DAYS,
  breakupStepNeedsCheck,
  campaignHasBreakupStepRule,
  formatBreakupStepFinding,
  isOneStepCampaign,
  sequenceStep3,
} from "./breakupStep.js";

const step1: SmartleadSequence = {
  id: 1,
  seq_number: 1,
  email_body: "<div>first</div>",
  seq_delay_details: { delay_in_days: 0, delayInDays: 0 },
};
const step2: SmartleadSequence = {
  id: 2,
  seq_number: 2,
  email_body: "<div>second</div>",
  seq_delay_details: { delay_in_days: 2, delayInDays: 2 },
};
const step3Ok: SmartleadSequence = {
  id: 3,
  seq_number: 3,
  email_body: "<div>breakup</div>",
  seq_delay_details: { delay_in_days: 2, delayInDays: 2 },
};
const step3Wrong: SmartleadSequence = {
  id: 3,
  seq_number: 3,
  email_body: "<div>breakup</div>",
  seq_delay_details: { delay_in_days: 4, delayInDays: 4 },
};

describe("breakupStep (D306 check only)", () => {
  it("step 3 must wait 2 days", () => {
    assert.equal(STEP3_DELAY_DAYS, 2);
    assert.equal(sequenceStep3([step1, step2, step3Ok])?.id, 3);
    assert.equal(sequenceStep3([step1, step2]), undefined);
  });

  it("flags missing step 3 and a wrong delay; clean step 3 is fine", () => {
    assert.equal(breakupStepNeedsCheck([step1, step2]), true);
    assert.equal(breakupStepNeedsCheck([step1, step2, step3Wrong]), true);
    assert.equal(breakupStepNeedsCheck([step1, step2, step3Ok]), false);
    assert.equal(
      formatBreakupStepFinding([step1, step2]),
      "step 3 missing (want delay 2d so it lands on day 4)",
    );
    assert.equal(
      formatBreakupStepFinding([step1, step2, step3Wrong]),
      "step 3 delay 4d (want 2 so it lands on day 4)",
    );
    assert.equal(formatBreakupStepFinding([step1, step2, step3Ok]), null);
    assert.equal(
      formatBreakupStepFinding([
        step1,
        step2,
        { ...step3Wrong, seq_delay_details: undefined },
      ]),
      "step 3 delay unset (want 2 so it lands on day 4)",
    );
  });

  it("skips 1-step test campaigns", () => {
    assert.equal(isOneStepCampaign([step1]), true);
    assert.equal(isOneStepCampaign([]), true);
    assert.equal(isOneStepCampaign(null), true);
    assert.equal(breakupStepNeedsCheck([step1]), false);
    assert.equal(formatBreakupStepFinding([step1]), null);
  });

  it("reuses the D186 shell skip and also exempts Gabe caller follow-ups", () => {
    assert.equal(
      campaignHasBreakupStepRule({ id: 1, name: "Goliath Education Receipts" }),
      true,
    );
    assert.equal(
      campaignHasBreakupStepRule({ id: 2, name: "Canary shell: #4 Live A" }),
      false,
    );
    assert.equal(
      campaignHasBreakupStepRule({ id: 3, name: "Pod control shell" }),
      false,
    );
    assert.equal(
      campaignHasBreakupStepRule({ id: 4, name: "DW Word Hunt Shell" }),
      false,
    );
    assert.equal(
      campaignHasBreakupStepRule({
        id: 4085158,
        name: "Gabe Calls | SalesGlider",
      }),
      false,
    );
  });
});
