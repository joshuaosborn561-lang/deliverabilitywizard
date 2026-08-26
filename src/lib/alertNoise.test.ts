import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  humanizeAlertError,
  isApprovalGateNoise,
  isBenignOpsNoise,
  isBurnChecklistNoise,
  isMissingSpamTestNoise,
  isRateLimitNoise,
  isRetryRemovalNoise,
  isSenderNotInCampaignNoise,
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

  it("treats gone SmartDelivery spam tests as benign ops noise", () => {
    const message = "test 502070: Spam test not found";
    assert.equal(isMissingSpamTestNoise(message), true);
    assert.equal(isBenignOpsNoise(message), true);
    assert.equal(isRateLimitNoise(message), false);
    assert.match(humanizeAlertError(message), /placement test is gone/i);
  });

  it("treats intentional unheld-retry summaries as benign ops noise", () => {
    const message =
      "escob.breanna@crossscaleco.com: 1 campaign removal(s) failed — left unheld so the next run retries";
    assert.equal(isRetryRemovalNoise(message), true);
    assert.equal(isBenignOpsNoise(message), true);
    assert.equal(isRateLimitNoise(message), false);
    assert.match(humanizeAlertError(message), /left it unheld/i);
  });

  it("treats D41 burn-checklist refusal as benign ops noise", () => {
    for (const domain of [
      "newvascowarranty.info",
      "trymeetconnect.info",
      "gogetintroduced.info",
      "vascowarrantynow.info",
    ]) {
      const message = `${domain}: burn checklist not ready (no corroborating same-ESP placement fail or bounce-over-threshold) — blacklist alone is not enough`;
      assert.equal(isBurnChecklistNoise(message), true, domain);
      assert.equal(isBenignOpsNoise(message), true, domain);
      assert.equal(isRateLimitNoise(message), false, domain);
      assert.match(humanizeAlertError(message), /blacklist alone is not enough/i);
    }
    assert.equal(
      isBurnChecklistNoise("delete SL account x@y.com: connection reset"),
      false,
    );
  });

  it("treats SmartDelivery sender-not-in-campaign as benign ops noise", () => {
    const message =
      "Failed creating tests for campaign 3701207: Sender email accounts minh.nguyen@useculturefits.info, omar.hassan@proculturefits.info not used in the campaign";
    assert.equal(isSenderNotInCampaignNoise(message), true);
    assert.equal(isBenignOpsNoise(message), true);
    assert.equal(isRateLimitNoise(message), false);
    assert.match(humanizeAlertError(message), /membership lag/i);
  });

  it("explains missing SmartDelivery seed accounts in plain English", () => {
    assert.match(
      humanizeAlertError(
        "Failed creating tests for campaign 3798227: No seed accounts found for the provided provider IDs",
      ),
      /no seed inboxes for the provider IDs/i,
    );
    // Still pages Slack — human/config must fix PROVIDER_IDS or seed capacity.
    assert.equal(
      isRateLimitNoise(
        "Failed creating tests for campaign 3798227: No seed accounts found for the provided provider IDs",
      ),
      false,
    );
  });

  it("explains SmartDelivery sequence-credit exhaustion in plain English", () => {
    assert.match(
      humanizeAlertError(
        "Failed creating tests for campaign 3763798: Insufficient sequence credits",
      ),
      /out of sequence credits/i,
    );
    // Still pages Slack — human must top up — but not remediator noise.
    assert.equal(
      isRateLimitNoise(
        "Failed creating tests for campaign 3763798: Insufficient sequence credits",
      ),
      false,
    );
  });

  it("treats HTTP 524 / upstream 5xx as non-paging noise", () => {
    for (const message of [
      "bounce stats: HTTP 524",
      "list accounts: HTTP 502",
      "health metrics: HTTP 503",
    ]) {
      assert.equal(isRateLimitNoise(message), true, message);
      assert.equal(isBenignOpsNoise(message), true, message);
    }
    assert.match(
      humanizeAlertError("bounce stats: HTTP 524"),
      /temporary gateway\/server error/i,
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
