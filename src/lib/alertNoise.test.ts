import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  humanizeAlertError,
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

  it("treats request aborts / timeouts as non-paging noise", () => {
    for (const message of [
      "bounce stats: This operation was aborted",
      "bounce stats: request timed out after 60000ms",
      "health metrics: TimeoutError: request timed out after 180000ms",
    ]) {
      assert.equal(isRateLimitNoise(message), true, message);
    }
    assert.match(
      humanizeAlertError("bounce stats: This operation was aborted"),
      /timed out/i,
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
