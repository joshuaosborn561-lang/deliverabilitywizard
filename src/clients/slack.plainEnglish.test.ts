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

describe("notifyPlacementResult is quiet (D71/D158)", () => {
  it("does not post a placement Slack page", async () => {
    const { client, sent } = capture();
    await client.notifyPlacementResult({
      testName: "Canary copy: #3847794 AirPods",
      testId: "t1",
      threshold: 80,
      providers: [{ name: "Gmail", inboxPercent: 0 }],
      remediationThreshold: 80,
    });
    assert.deepEqual(sent, []);
  });
});

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
      remediationThreshold: 80,
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
          reason: "under_warmed",
          daysWarmed: 14,
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
      endOfDay: true,
      staffingShorts: [
        {
          name: "BCP PE Firms",
          staffable: 22,
          shortBy: 22,
          status: "ACTIVE",
        },
      ],
      loadedDrafts: [
        { id: 99, name: "Parlay3 Launch", remaining: 2400 },
      ],
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

    await client.notifyIsolationVerdict({
      campaignName: "Acme Healthcare",
      clientName: "Acme",
      dateLabel: "Aug 23",
      verdict: "COPY",
      reason: "The standing inbox test landed.",
      repliesFrom: 11,
      repliesTo: 0,
      oooFrom: 6,
      oooTo: 0,
      bounceFlat: true,
      teardownStarted: true,
    });
    await client.notifyCopyIsolation({
      campaignName: "Acme Healthcare",
      recovered: [{ element: "free", kind: "word" }],
      unchanged: ["phone"],
    });
    await client.notifyPodControls({
      pods: 2,
      testsCreated: 2,
      sendersRead: 10,
      kill: 1,
      watch: 2,
      errors: [],
    });
    await client.notifyIsolationAction({
      title: "Buy a replacement for acme.info",
      proof: "What I ran: the known-good email from 3 inboxes on acme.info.\nWho failed: a@acme.info, b@acme.info, c@acme.info.",
      actionId: "buy-1",
      kind: "buy_domains",
      who: "Josh",
    });
    await client.notifyLeadRunout({
      text: "Parlay A is three quarters through its list. About 400 leads left, sending about 200 a day, so about 2 days. This one is working, so running out matters. You need the next batch in hand. I have not imported anything.",
    });
    await client.notifySendingInfra({
      text: "Our mailboxes are sending from reputable ranges in the right region.\nThe add-on that claims a reply lift by moving inboxes onto better IPs would buy us nothing. Drop it.",
    });

    assert.ok(sent.length >= 7);
    for (const [i, text] of sent.entries()) {
      assertPlain(text, `message ${i}`);
    }
  });
});
