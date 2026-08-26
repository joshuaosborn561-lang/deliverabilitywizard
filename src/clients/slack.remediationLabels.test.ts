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

    assert.match(sent[0]!, /1 inbox on this test landed below 80%/);
    assert.doesNotMatch(sent[0]!, /weak@x\.com/);
  });

  it("midday client day brief does not Slack (D71)", async () => {
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
          heldInboxes: 34,
          restingInboxes: 20,
          genericSpare: 12,
        },
      ],
      errors: [],
    });
    assert.equal(sent.length, 0);
  });

  it("end-of-day brief is client sends and spam only (D71)", async () => {
    const { client, sent } = capture();
    await client.notifyClientDayBrief({
      date: "2026-08-24",
      totalSent: 10,
      rows: [
        {
          clientName: "BCP",
          sent: 10,
          bouncePercent: 1,
          spamPercent: 0,
          activeInboxes: 22,
          heldInboxes: 0,
          restingInboxes: 22,
          genericSpare: 0,
        },
      ],
      errors: [],
      endOfDay: true,
      staffingShorts: [
        {
          name: "BCP PE Firms (No Team)",
          staffable: 22,
          shortBy: 22,
          status: "ACTIVE",
        },
      ],
    });
    assert.match(sent[0]!, /Client day — 2026-08-24/);
    assert.match(sent[0]!, /BCP/);
    assert.match(sent[0]!, /10 sent · 0\.0% spam/);
    assert.doesNotMatch(sent[0]!, /Staffing \(end of day\)/);
    assert.doesNotMatch(sent[0]!, /on \/ .* off/);
    assert.doesNotMatch(sent[0]!, /not enough warmed spares/i);
  });

  it("D89: EOD brief names draft campaigns that already have leads", async () => {
    const { client, sent } = capture();
    await client.notifyClientDayBrief({
      date: "2026-08-26",
      totalSent: 10,
      rows: [
        {
          clientName: "BCP",
          sent: 10,
          bouncePercent: 1,
          spamPercent: 0,
          activeInboxes: 22,
          heldInboxes: 0,
        },
      ],
      errors: [],
      endOfDay: true,
      loadedDrafts: [
        { id: 99, name: "Parlay3 Launch", remaining: 2400 },
      ],
    });
    assert.match(sent[0]!, /Leads loaded, not sending \(1\)/);
    assert.match(sent[0]!, /Parlay3 Launch \(#99\)/);
    assert.match(sent[0]!, /2,400 leads sitting in draft/);
    assert.doesNotMatch(sent[0]!, /staffable/i);
    assert.doesNotMatch(sent[0]!, /DRAFTED/);
  });
});
