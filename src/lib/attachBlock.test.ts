import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isolationAskBlocksDomain,
  isSenderAttachBlocked,
  mergeAttachBlock,
  senderIsAttachBlocked,
} from "./attachBlock.js";

describe("attachBlock (D176)", () => {
  it("merges emails and account ids onto one domain record", () => {
    const first = mergeAttachBlock(undefined, {
      domain: "Cleartechco.com",
      emails: ["ada@cleartechco.com"],
      accountIds: [11],
      reason: "sender_blocked",
      source: "campaign:1",
      blockedAt: "2026-09-03T20:23:00.000Z",
    });
    const merged = mergeAttachBlock(first, {
      domain: "cleartechco.com",
      emails: ["ben@cleartechco.com"],
      accountIds: [11, 12],
      reason: "sender_blocked",
    });
    assert.equal(merged.domain, "cleartechco.com");
    assert.deepEqual(merged.emails, [
      "ada@cleartechco.com",
      "ben@cleartechco.com",
    ]);
    assert.deepEqual(merged.accountIds, [11, 12]);
    assert.equal(merged.blockedAt, "2026-09-03T20:23:00.000Z");
  });

  it("blocks a sender by domain, email, or account id", () => {
    const blocks = [
      mergeAttachBlock(undefined, {
        domain: "cleartechco.com",
        emails: ["ada@cleartechco.com"],
        accountIds: [42],
        reason: "sender_blocked",
      }),
    ];
    assert.equal(
      isSenderAttachBlocked(
        { email: "other@cleartechco.com" },
        { blocks },
      ),
      true,
      "domain block covers every inbox on that domain",
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "ada@other.com", accountId: 42 },
        { blocks },
      ),
      true,
      "account id is enough even on another domain",
    );
    assert.equal(
      isSenderAttachBlocked({ email: "ok@healthy.info" }, { blocks }),
      false,
    );
  });

  it("retired history stays off (D65) and pending cover/retire asks block too", () => {
    assert.equal(
      isSenderAttachBlocked(
        { email: "gone@retired.info" },
        { domainHistory: { status: "retired" } },
      ),
      true,
    );
    assert.equal(
      isolationAskBlocksDomain("cleartechco.com", [
        {
          kind: "buy_domains",
          status: "pending",
          detail: { domain: "cleartechco.com", coverOnly: true },
        },
      ]),
      true,
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "ada@cleartechco.com" },
        {
          isolationActions: [
            {
              kind: "buy_domains",
              status: "pending",
              detail: { domain: "cleartechco.com", coverOnly: true },
            },
          ],
        },
      ),
      true,
      "a protected-client cover ask is enough to refuse restaff",
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "ada@cleartechco.com" },
        {
          isolationActions: [
            {
              kind: "buy_domains",
              status: "pending",
              detail: { domain: "cleartechco.com" },
            },
          ],
        },
      ),
      false,
      "an ordinary buy-ahead (not coverOnly) is not an attach block",
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "burned@bcp.info" },
        {
          isolationActions: [
            {
              kind: "retire_domain",
              status: "denied",
              detail: { domain: "bcp.info" },
            },
          ],
        },
      ),
      false,
      "a denied placement retire does not lock the domain",
    );
  });

  it("senderIsAttachBlocked reads the store shape used by attach writers", () => {
    const state = {
      listAttachBlocks: () => [
        mergeAttachBlock(undefined, {
          domain: "boldercyperpartnerhub.info",
          reason: "restricted",
        }),
      ],
      getDomainHistory: () => undefined,
      listIsolationActions: () => [],
    };
    assert.equal(
      senderIsAttachBlocked(
        { email: "x@boldercyperpartnerhub.info", accountId: 9 },
        state,
      ),
      true,
    );
    assert.equal(
      senderIsAttachBlocked({ email: "ok@client.info" }, state),
      false,
    );
  });
});
