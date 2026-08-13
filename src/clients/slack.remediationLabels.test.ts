import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlackClient } from "./slack.js";

/**
 * The remediation alert reports two different measures in one field:
 * placement pulls carry a same-ESP inbox %, bounce pulls carry a bounce %.
 * Rendering both as a bare "25%" reads as an inbox rate either way, which
 * inverts the meaning for bounce pulls.
 */

function capture() {
  const sent: string[] = [];
  const client = new SlackClient({ channelLabel: "#test" });
  (client as unknown as { send: (t: string) => Promise<void> }).send = async (
    text: string,
  ) => {
    sent.push(text);
  };
  return { client, sent };
}

const base = {
  deletedSmartleadAccounts: [],
  purgedInboxKitDomains: [],
  clientActions: [],
  holdTagged: 0,
  pausedCampaigns: [],
  errors: [],
};

describe("remediation alert measure labels", () => {
  it("labels a placement pull as same-ESP inbox", async () => {
    const { client, sent } = capture();
    await client.notifyRemediation({
      ...base,
      recoveredInboxes: [
        {
          id: 1,
          email: "weak@x.com",
          inboxRate: 45,
          scoredSameEsp: true,
          removedFromCampaigns: [10],
          holdUntil: "2026-08-26",
        },
      ],
    } as never);

    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /weak@x\.com` — 45% same-ESP inbox/);
    assert.doesNotMatch(sent[0]!, /blended/);
  });

  it("labels a bounce pull as bounce, not inbox", async () => {
    const { client, sent } = capture();
    await client.notifyRemediation({
      ...base,
      recoveredInboxes: [
        {
          id: 2,
          email: "bouncer@x.com",
          inboxRate: 25,
          bounceDriven: true,
          removedFromCampaigns: [10],
        },
      ],
    } as never);

    // 25% bounce is bad; 25% inbox is a different claim entirely.
    assert.match(sent[0]!, /bouncer@x\.com` — 25% bounce/);
    assert.doesNotMatch(sent[0]!, /25% inbox/);
  });

  it("says same-ESP on a weak sender that is about to be pulled", async () => {
    const { client, sent } = capture();
    await client.notifyPlacementResult({
      testId: "t1",
      testName: "Campaign",
      threshold: 80,
      providers: [{ name: "G Suite", inboxPercent: 40 }],
      autoRemediation: true,
      remediationThreshold: 80,
      holdDays: 14,
      senders: [
        {
          email: "weak@x.com",
          inboxPercent: 40,
          scoredSameEsp: true,
          willRemediate: true,
        },
      ],
    } as never);

    assert.match(sent[0]!, /weak@x\.com` — 40\.0% _\(same-ESP\)_/);
    assert.match(sent[0]!, /pulling off campaigns/);
  });

  it("marks a blended score as not driving rotation (D32)", async () => {
    const { client, sent } = capture();
    await client.notifyPlacementResult({
      testId: "t1",
      testName: "Campaign",
      threshold: 80,
      providers: [{ name: "G Suite", inboxPercent: 40 }],
      autoRemediation: true,
      remediationThreshold: 80,
      senders: [
        {
          email: "blendedonly@x.com",
          inboxPercent: 40,
          scoredSameEsp: false,
          willRemediate: false,
        },
      ],
    } as never);

    assert.match(sent[0]!, /not used for rotation/);
  });
});
