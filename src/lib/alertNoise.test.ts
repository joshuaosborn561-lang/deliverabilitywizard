import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
});
