import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlackClient } from "./slack.js";
import { slackJargonHits } from "../lib/slackPlainEnglish.js";

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

function assertPlain(text: string, label: string): void {
  const hits = slackJargonHits(text);
  assert.deepEqual(hits, [], `${label} still has jargon: ${hits.join(", ")}`);
}

describe("Slack copy is plain English (D47)", () => {
  it("quota, placement, warmup, reconnect, remediation, day brief", async () => {
    const { client, sent } = capture();

    await client.notifyQuotaBlocked({
      used: 10,
      quota: 12,
      needed: 3,
      campaigns: [{ id: 1, name: "Acme", testsNeeded: 1 }],
    });
    await client.notifyPlacementResult({
      testName: "Acme Sports",
      testId: "t1",
      threshold: 80,
      providers: [{ name: "G Suite", inboxPercent: 40 }],
      autoRemediation: true,
      remediationThreshold: 80,
      holdDays: 14,
      senders: [{ email: "a@x.com", inboxPercent: 40 }],
    });
    await client.notifyWarmupGate({
      campaignsScanned: 2,
      accountsChecked: 4,
      removed: 2,
      skipped: 0,
      pausedCampaigns: [],
      removals: [
        {
          campaignId: 1,
          campaignName: "Acme",
          email: "a@x.com",
          reason: "hold_until",
          daysWarmed: 14,
          holdUntil: "2026-09-01",
        },
        {
          campaignId: 1,
          campaignName: "Acme",
          email: "b@x.com",
          reason: "under_warmed",
          daysWarmed: 3,
        },
      ],
      errors: [],
    });
    await client.notifyReconnect({
      scanned: 10,
      disconnected: 1,
      reconnected: 1,
      skippedAlreadyConnected: 0,
      failed: 0,
      inboxkitReexports: 1,
      errors: [],
      actions: [{ email: "a@x.com", message: "ok", reauthenticated: true }],
    });
    await client.notifyRemediation({
      dryRun: false,
      blacklistedDomains: [],
      deletedSmartleadAccounts: [],
      purgedInboxKitDomains: [],
      recoveredInboxes: [
        {
          id: 1,
          email: "weak@x.com",
          inboxRate: 40,
          scoredSameEsp: true,
          removedFromCampaigns: [1],
          clientName: "Acme",
        },
      ],
      clientActions: [],
      pausedCampaigns: [],
      errors: [],
    });
    await client.notifyClientDayBrief({
      date: "2026-08-21",
      totalSent: 100,
      rows: [
        {
          clientName: "Acme",
          sent: 100,
          bouncePercent: 1,
          spamPercent: 2,
          activeInboxes: 10,
          heldInboxes: 1,
          restingInboxes: 4,
          genericSpare: 3,
        },
      ],
      errors: [],
    });
    await client.notifyTestReconcile({
      dryRun: false,
      automatedTests: 2,
      stopped: [
        {
          testId: "t1",
          testName: "Acme",
          campaignId: "1",
          campaignStatus: "PAUSED",
        },
      ],
      orphaned: [],
      errors: [],
    });
    await client.notifyBlacklistDiagnosis({
      testId: "t1",
      testName: "Acme",
      diagnoses: [
        {
          domain: "acme.info",
          verdict: "shared_ip",
          reason: "IP is shared",
          recommendation: "Take the IP to InboxKit",
          listings: ["spamhaus"],
          ips: ["1.2.3.4"],
          sharedWithDomains: ["other.info"],
        },
      ],
    });

    assert.ok(sent.length >= 7);
    for (const [i, text] of sent.entries()) {
      assertPlain(text, `message ${i}`);
    }
  });
});
