import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasActionButtons,
  oneTapOnly,
  slackAllowed,
  slackKindForIsolationAction,
} from "./slackAllow.js";

describe("slackAllowed", () => {
  it("only burned domain, isolated word, EOD, and button results (D71)", () => {
    assert.equal(slackAllowed(), false);
    assert.equal(slackAllowed(null), false);
    assert.equal(slackAllowed("eod_summary"), true);
    assert.equal(slackAllowed("burned_domain"), true);
    assert.equal(slackAllowed("copy_word"), true);
    assert.equal(slackAllowed("action_result"), true);
    assert.equal(slackAllowed("generic_backfill" as never), false);
    assert.equal(slackKindForIsolationAction("generic_backfill"), null);
    assert.equal(slackKindForIsolationAction("retire_domain"), "burned_domain");
    assert.equal(slackKindForIsolationAction("buy_domains"), "burned_domain");
    assert.equal(slackKindForIsolationAction("swap_copy"), "copy_word");
    assert.equal(slackKindForIsolationAction("add_signature_tag"), null);
    assert.equal(slackKindForIsolationAction("buy_canary_fleet"), null);
  });
});

describe("one-tap-only flag (Oct 31 2026)", () => {
  it("is off by default and on for truthy values", () => {
    assert.equal(oneTapOnly({} as NodeJS.ProcessEnv), false);
    assert.equal(oneTapOnly({ DELIVERABILITY_SLACK_ONE_TAP_ONLY: "true" }), true);
    assert.equal(oneTapOnly({ DELIVERABILITY_SLACK_ONE_TAP_ONLY: "0" }), false);
  });
  it("only messages with an actions block count as one-tap asks", () => {
    assert.equal(hasActionButtons(undefined), false);
    assert.equal(hasActionButtons([{ type: "section" }]), false);
    assert.equal(hasActionButtons([{ type: "section" }, { type: "actions" }]), true);
  });
});
