import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  genericEligibleForClientPod,
  lockedGenericPod,
  rankGenericsOldestWorstFirst,
  stampMailboxPodTag,
  stripMailboxPodTags,
} from "./genericAssign.js";
import { emptyGenericSeat } from "./genericPool.js";

describe("D230 generic assign lock", () => {
  it("lets an untagged pool seat take any short POD", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "A",
      }),
      true,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "B",
        mailboxClientId: null,
        assignedClientId: null,
        tags: [{ tag_name: "GENERIC" }],
      }),
      true,
    );
  });

  it("lets a same-client same-POD generic stay", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "B",
        mailboxClientId: 77,
        assignedPod: "B",
        tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
      }),
      true,
    );
  });

  it("rejects another client's generic and the other POD", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "A",
        mailboxClientId: 88,
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "A",
        mailboxClientId: 77,
        tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
      }),
      false,
    );
    assert.equal(
      lockedGenericPod({
        tags: [{ tag_name: "POD-A" }],
        assignedPod: "B",
      }),
      "A",
    );
  });

  it("ranks oldest / worst first", () => {
    const ranked = rankGenericsOldestWorstFirst([
      emptyGenericSeat("new@getintroduced.info", {
        assignedAt: "2026-10-03T00:00:00.000Z",
      }),
      emptyGenericSeat("old@getintroduced.info", {
        assignedAt: "2026-10-01T00:00:00.000Z",
      }),
    ]);
    assert.deepEqual(
      ranked.map((row) => row.email),
      ["old@getintroduced.info", "new@getintroduced.info"],
    );
  });

  it("stamps a first POD tag without carrying the other side", () => {
    const stamped = stampMailboxPodTag([{ tag_name: "GENERIC" }, { tag_name: "POD-B" }], "A");
    assert.deepEqual(stamped, [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }]);
    assert.deepEqual(stripMailboxPodTags(stamped), [{ tag_name: "GENERIC" }]);
  });
});
