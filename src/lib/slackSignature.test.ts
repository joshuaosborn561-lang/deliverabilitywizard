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
    assert.deepEqual(
      parseIsolationActionValue(
        isolationActionValue(
          "buy_canary_fleet",
          "buy_canary_fleet-1787514583731-e260ym",
          "approve",
        ),
      ),
      {
        kind: "buy_canary_fleet",
        id: "buy_canary_fleet-1787514583731-e260ym",
        decision: "approve",
      },
    );
    assert.deepEqual(
      parseIsolationActionValue(
        isolationActionValue("swap_copy", "swap_copy-1", "edit"),
      ),
      { kind: "swap_copy", id: "swap_copy-1", decision: "edit" },
    );
  });
});
