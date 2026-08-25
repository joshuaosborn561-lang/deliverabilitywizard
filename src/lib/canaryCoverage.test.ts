import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasLivingUnwarmedCopyCanary,
  livingKnownGoodEmails,
} from "./canaryCoverage.js";

describe("livingKnownGoodEmails", () => {
  it("only counts inboxes on a living pod-control test", () => {
    const emails = livingKnownGoodEmails(
      [
        {
          id: "pc-1",
          test_name: "Pod control: client:9:B",
          status: "active",
          every_days: 1,
        },
        {
          id: "dead",
          test_name: "Pod control: old",
          status: "completed",
        },
      ],
      [
        { spamTestId: "pc-1", emails: ["a@client.com", "B@client.com"] },
        { spamTestId: "dead", emails: ["gone@client.com"] },
      ],
    );
    assert.deepEqual([...emails].sort(), ["a@client.com", "b@client.com"]);
  });

  it("covers nobody when there is no living known-good test", () => {
    const emails = livingKnownGoodEmails(
      [{ id: "copy", test_name: "Canary copy: #1", status: "active", every_days: 1 }],
      [{ spamTestId: "pc-1", emails: ["a@client.com"] }],
    );
    assert.equal(emails.size, 0);
  });
});

describe("hasLivingUnwarmedCopyCanary", () => {
  it("matches a living Canary copy test by campaign id", () => {
    assert.equal(
      hasLivingUnwarmedCopyCanary(3815448, [
        {
          id: "t-canary",
          test_name: "Canary copy: #3815448 Goliath Displacement L",
          status: "active",
          every_days: 1,
        },
      ]),
      true,
    );
    assert.equal(
      hasLivingUnwarmedCopyCanary(3815448, [
        {
          id: "t-place",
          test_name: "Auto: Goliath Displacement L",
          status: "active",
          every_days: 1,
          campaign_id: 3815448,
        },
      ]),
      false,
    );
  });
});
