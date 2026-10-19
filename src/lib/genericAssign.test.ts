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

  it("D258: live Smartlead client_id wins when pool assignedClientId disagrees", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 592842,
        targetPod: "A",
        mailboxClientId: 521881,
        assignedClientId: 592842,
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 521881,
        targetPod: "A",
        mailboxClientId: 521881,
        assignedClientId: 592842,
        tags: [{ tag_name: "GENERIC" }],
      }),
      true,
    );
  });

  it("D283: Onboarding-freed PowerGRYD generics must not flip back onto 592842", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 592842,
        targetPod: "A",
        mailboxClientId: null,
        assignedClientId: 592842,
        assignedReason: "powergryd_dedicated",
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 592842,
        targetPod: "A",
        mailboxClientId: null,
        assignedClientId: null,
        releaseHistory: [{ reason: "onboarding_freed_powergryd" }],
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
    );
  });

  it("D290: leftover mailbox client_id and Onboarding-freed seats may fill other named PODs", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 574020,
        targetPod: "B",
        mailboxClientId: 548611,
        assignedClientId: null,
        tags: [{ tag_name: "GENERIC" }],
      }),
      true,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 574020,
        targetPod: "A",
        mailboxClientId: null,
        assignedClientId: null,
        releaseHistory: [{ reason: "onboarding_freed_powergryd" }],
        tags: [{ tag_name: "GENERIC" }],
        allowFreedPowerGrydSupply: true,
      }),
      true,
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 548611,
        targetPod: "A",
        mailboxClientId: null,
        assignedClientId: null,
        releaseHistory: [{ reason: "onboarding_freed_powergryd" }],
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
      "one-client / Goliath dump still blocked without the min40 flag",
    );
    assert.equal(
      genericEligibleForClientPod({
        clientId: 582890,
        targetPod: "A",
        mailboxClientId: null,
        assignedClientId: null,
        tags: [{ tag_name: "GENERIC" }],
      }),
      false,
      "Insight still never receives generics",
    );
  });

  it("rejects a live-assigned other-client generic and the other POD", () => {
    assert.equal(
      genericEligibleForClientPod({
        clientId: 77,
        targetPod: "A",
        mailboxClientId: 88,
        assignedClientId: 88,
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

  it("stamps a first POD tag on an untagged seat", () => {
    const stamped = stampMailboxPodTag([{ tag_name: "GENERIC" }], "A");
    assert.deepEqual(stamped, [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }]);
    assert.deepEqual(stripMailboxPodTags(stamped), [{ tag_name: "GENERIC" }]);
  });

  it("D234: refuses to flip an already-tagged POD", () => {
    const stamped = stampMailboxPodTag(
      [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }],
      "A",
    );
    assert.deepEqual(stamped, [{ tag_name: "GENERIC" }, { tag_name: "POD-B" }]);
  });
});
