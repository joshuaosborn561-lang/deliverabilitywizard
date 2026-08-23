import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  isolationActionValue,
  parseIsolationActionValue,
  slackSignatureValid,
} from "./slackSignature.js";

describe("slack signature", () => {
  it("accepts a fresh Slack-signed body and rejects a bad one", () => {
    const secret = "test-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "payload=%7B%7D";
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;
    assert.equal(
      slackSignatureValid({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature,
      }),
      true,
    );
    assert.equal(
      slackSignatureValid({
        signingSecret: secret,
        timestamp,
        rawBody,
        signature: "v0=deadbeef",
      }),
      false,
    );
  });

  it("round-trips button values", () => {
    const value = isolationActionValue("buy_domains", "abc", "approve");
    assert.deepEqual(parseIsolationActionValue(value), {
      kind: "buy_domains",
      id: "abc",
      decision: "approve",
    });
  });
});
