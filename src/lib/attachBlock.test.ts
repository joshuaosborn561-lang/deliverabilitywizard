import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isolationAskBlocksDomain,
  isSenderAttachBlocked,
  mergeAttachBlock,
  recordInfraIsolationUnlink,
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
      "a leftover coverOnly buy ask is enough to refuse restaff",
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

  it("INFRA unlink path writes bounce_isolation when known-good condemns the domain", () => {
    const blocks = new Map();
    const store = {
      upsertAttachBlock: (incoming: {
        domain: string;
        emails?: Iterable<string>;
        accountIds?: Iterable<number>;
        reason: "bounce_isolation";
        source?: string;
      }) => {
        const merged = mergeAttachBlock(blocks.get(incoming.domain), incoming);
        blocks.set(merged.domain, merged);
        return merged;
      },
    };
    const wrote = recordInfraIsolationUnlink(
      store,
      [
        {
          id: 21442842,
          from_email: "jeremy@boldercyperpartnertop.info",
        },
        {
          id: 21442456,
          from_email: "hugo@boldercyperpartnertop.info",
        },
        { id: 99, from_email: "ok@healthy.info" },
      ],
      {
        campaignId: 3763800,
        placementOf: (email) =>
          email.endsWith("@boldercyperpartnertop.info") ? "SPAM" : "PRIMARY",
      },
    );
    assert.equal(wrote.length, 1);
    assert.equal(wrote[0]!.domain, "boldercyperpartnertop.info");
    assert.equal(wrote[0]!.reason, "bounce_isolation");
    assert.deepEqual(wrote[0]!.emails, [
      "hugo@boldercyperpartnertop.info",
      "jeremy@boldercyperpartnertop.info",
    ]);
    assert.deepEqual(wrote[0]!.accountIds, [21442456, 21442842]);
    assert.equal(
      isSenderAttachBlocked(
        { email: "kim@boldercyperpartnertop.info" },
        { blocks: [...blocks.values()] },
      ),
      true,
      "domain block covers every inbox on that domain",
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "ok@healthy.info" },
        { blocks: [...blocks.values()] },
      ),
      false,
      "a healthy sibling domain is not blocked",
    );
  });

  it("INFRA unlink path writes nothing when known-good did not condemn a domain", () => {
    const wrote = recordInfraIsolationUnlink(
      {
        upsertAttachBlock: () => {
          throw new Error("must not write");
        },
      },
      [{ id: 1, from_email: "a@techevo.test" }],
      {
        campaignId: 1,
        placementOf: () => "PRIMARY",
      },
    );
    assert.deepEqual(wrote, []);
  });
});
