import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure } from "../lib/failureClassifier.js";
import type { SpendApprovalRecord } from "../state/store.js";
import { isHumanDeniedTeardown } from "./remediation.js";

function stateWith(record: SpendApprovalRecord | undefined) {
  return {
    getLatestSpendApprovalForRequest: (key: string) =>
      record && (record.requestKey ?? record.id) === key ? record : undefined,
  };
}

describe("denied blacklist teardown approvals", () => {
  it("treats a human denial as final for that domain", () => {
    const state = stateWith({
      id: "teardown-domain:crossscaleco.com",
      requestKey: "teardown-domain:crossscaleco.com",
      kind: "blacklisted_domain_teardown",
      description: "Delete mailboxes on crossscaleco.com",
      detail: { domain: "crossscaleco.com" },
      requestedAt: "2026-08-01T00:00:00.000Z",
      status: "denied",
      decidedAt: "2026-08-02T00:00:00.000Z",
      decidedBy: "josh",
    });
    assert.equal(isHumanDeniedTeardown(state, "crossscaleco.com"), true);
    assert.equal(isHumanDeniedTeardown(state, "CrossScaleCo.com"), true);
  });

  it("does not treat pending or approved as human-denied", () => {
    assert.equal(
      isHumanDeniedTeardown(
        stateWith({
          id: "teardown-domain:example.com",
          requestKey: "teardown-domain:example.com",
          kind: "blacklisted_domain_teardown",
          description: "x",
          detail: {},
          requestedAt: "2026-08-01T00:00:00.000Z",
          status: "pending",
        }),
        "example.com",
      ),
      false,
    );
    assert.equal(
      isHumanDeniedTeardown(
        stateWith({
          id: "teardown-domain:example.com",
          requestKey: "teardown-domain:example.com",
          kind: "blacklisted_domain_teardown",
          description: "x",
          detail: {},
          requestedAt: "2026-08-01T00:00:00.000Z",
          status: "approved",
          decidedBy: "josh",
        }),
        "example.com",
      ),
      false,
    );
  });

  it("ignores monthly-cap denials so they can cycle later", () => {
    assert.equal(
      isHumanDeniedTeardown(
        stateWith({
          id: "teardown-domain:example.com:cap:1",
          requestKey: "teardown-domain:example.com",
          kind: "blacklisted_domain_teardown",
          description: "x BLOCKED: cap",
          detail: {},
          requestedAt: "2026-08-01T00:00:00.000Z",
          status: "denied",
          decidedBy: "monthly-cap",
        }),
        "example.com",
      ),
      false,
    );
  });

  it("stops the production fingerprint from auto-remediating", () => {
    const classified = classifyFailure(
      "remediation",
      "crossscaleco.com: teardown awaiting approval (denied) — see GET /approvals",
    );
    assert.equal(classified.autoRemediate, false);
    assert.equal(classified.class, "noise");
    assert.equal(classified.fingerprint, "noise:approval-gate");
    assert.notEqual(
      classified.fingerprint,
      "unknown:remediation:remediation-crossscaleco-com-teardown-awaiting-a",
    );
  });
});
