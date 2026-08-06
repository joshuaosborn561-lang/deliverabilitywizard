import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  humanizeAlertError,
  isApprovalGateNoise,
  isBenignOpsNoise,
  isRateLimitNoise,
  reconnectFailureCategory,
} from "./alertNoise.js";

describe("alert noise", () => {
  it("recognizes Smartlead HTTP 429 variants", () => {
    for (const message of [
      "audit list campaigns: HTTP 429",
      "rate limit exceeded",
      "Too Many Requests",
      "reauth x@example.com: 429",
    ]) {
      assert.equal(isRateLimitNoise(message), true, message);
    }
    assert.equal(
      isRateLimitNoise("Failed to reconnect email account"),
      false,
    );
  });

  it("treats pending/denied approval waits as benign ops noise", () => {
    const denied =
      "boldercyperpartnersys.info: teardown awaiting approval (denied) — see GET /approvals";
    assert.equal(isApprovalGateNoise(denied), true);
    assert.equal(isBenignOpsNoise(denied), true);
    assert.equal(isRateLimitNoise(denied), false);
    assert.equal(
      isApprovalGateNoise("delete SL account x@y.com: connection reset"),
      false,
    );
  });

  it("groups manual OAuth errors into one stable category", () => {
    assert.equal(
      reconnectFailureCategory("AADSTS50076: MFA required"),
      "manual-oauth",
    );
    assert.equal(
      reconnectFailureCategory("Failed to reconnect email account"),
      "manual-oauth",
    );
    assert.equal(reconnectFailureCategory("HTTP 429"), "rate-limit");
  });

  it("explains warmup-gate rate limits in plain English", () => {
    assert.match(
      humanizeAlertError("list accounts: HTTP 429"),
      /rate-limited us while loading the mailbox list/i,
    );
    assert.match(
      humanizeAlertError("list accounts: HTTP 429"),
      /Nothing was changed/i,
    );
  });

  it("keeps mailbox identifiers when humanizing remove/swap failures", () => {
    assert.match(
      humanizeAlertError(
        "remove josh@example.com from campaign 123: HTTP 429",
      ),
      /josh@example\.com/,
    );
    assert.match(
      humanizeAlertError(
        "swap-in weak@example.com ← pool@example.com: HTTP 429",
      ),
      /weak@example\.com/,
    );
  });
});
