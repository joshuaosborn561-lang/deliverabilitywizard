import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlackClient } from "./slack.js";

/**
 * D39 — Slack fleet updates are client-level (counts + day bounce/spam), not
 * per-mailbox lists. Remediation still names SPF/DKIM failures.
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

describe("remediation / placement Slack is client-level (D39)", () => {
  it("summarizes pulls per client instead of listing each mailbox", async () => {
    const { client, sent } = capture();
    await client.notifyRemediation({
      ...base,
      dryRun: false,
      blacklistedDomains: [],
      recoveredInboxes: [
        {
          id: 1,
          email: "weak@x.com",
          inboxRate: 45,
          scoredSameEsp: true,
          removedFromCampaigns: [10],
          holdUntil: "2026-08-26",
          clientName: "Acme",
        },
        {
          id: 2,
          email: "weak2@x.com",
          inboxRate: 30,
          scoredSameEsp: true,
          removedFromCampaigns: [10],
          clientName: "Acme",
        },
      ],
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /\*Acme\* — 2/);
    assert.doesNotMatch(sent[0]!, /weak@x\.com/);
  });

  it("placement alerts count weak senders without listing emails", async () => {
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
    });

    assert.match(sent[0]!, /1 sender under 80%/);
    assert.doesNotMatch(sent[0]!, /weak@x\.com/);
  });

  it("client day brief shows sent / bounce / spam and rest counts", async () => {
    const { client, sent } = capture();
    await client.notifyClientDayBrief({
      date: "2026-08-17",
      totalSent: 1200,
      rows: [
        {
          clientName: "Goliath",
          sent: 400,
          bouncePercent: 2.5,
          spamPercent: 18,
          activeInboxes: 66,
          restingInboxes: 34,
        },
      ],
      errors: [],
    });

    assert.match(sent[0]!, /Client day — 2026-08-17/);
    assert.match(sent[0]!, /Goliath/);
    assert.match(sent[0]!, /2\.5% bounce/);
    assert.match(sent[0]!, /18\.0% spam/);
    assert.match(sent[0]!, /66 active \/ 34 resting/);
  });
});
