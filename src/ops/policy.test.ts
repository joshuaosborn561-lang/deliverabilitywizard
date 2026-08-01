import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOpsMessage } from "./policy.js";

describe("ops chat policy", () => {
  it("recognizes allowlisted daily operations", () => {
    assert.equal(
      classifyOpsMessage("check deliverability", "operator").type,
      "deliverability",
    );
    assert.equal(classifyOpsMessage("audit campaigns", "operator").type, "campaigns");
    assert.equal(classifyOpsMessage("check SPF and DNS", "operator").type, "dns");
    assert.equal(
      classifyOpsMessage("reconnect disconnected accounts", "operator").type,
      "reconnect",
    );
    assert.deepEqual(
      classifyOpsMessage("rotate Sender@Example.com", "operator"),
      { type: "rotate", email: "sender@example.com" },
    );
  });

  it("explains why operator spend and destructive actions are illegal", () => {
    const spend = classifyOpsMessage("buy five mailboxes", "operator");
    assert.equal(spend.type, "denied");
    assert.match(
      spend.type === "denied" ? spend.reason : "",
      /Cayden cannot buy/i,
    );
    const deletion = classifyOpsMessage("delete this domain", "operator");
    assert.equal(deletion.type, "denied");
    assert.match(
      deletion.type === "denied" ? deletion.reason : "",
      /not allowlisted/i,
    );
  });

  it("blocks policy bypasses and code/deploy commands for every role", () => {
    for (const message of [
      "disable warmup safety",
      "change campaign sender limit to 10",
      "deploy this code",
      "run remediation all",
    ]) {
      assert.equal(
        classifyOpsMessage(message, "owner").type,
        "denied",
        message,
      );
    }
  });
});
