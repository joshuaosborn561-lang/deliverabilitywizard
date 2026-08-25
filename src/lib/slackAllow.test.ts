import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
    assert.equal(slackKindForIsolationAction("retire_domain"), "burned_domain");
    assert.equal(slackKindForIsolationAction("buy_domains"), "burned_domain");
    assert.equal(slackKindForIsolationAction("swap_copy"), "copy_word");
    assert.equal(slackKindForIsolationAction("buy_canary_fleet"), null);
  });
});
