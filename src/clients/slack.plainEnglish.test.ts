import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECONNECT_SLACK_LIST_CAP,
  SlackClient,
  slackReconnectBullets,
} from "./slack.js";
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

describe("notifyPlacementResult pages (D163)", () => {
  it("posts the first under-bar placement look", async () => {
    const { client, sent } = capture();
    await client.notifyPlacementResult({
      testName: "Canary copy: #3847794 AirPods",
      testId: "t1",
      threshold: 80,
      providers: [{ name: "Gmail", inboxPercent: 0 }],
      remediationThreshold: 80,
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /Placement look/);
    assert.match(sent[0] ?? "", /Gmail/);
    assertPlain(sent[0] ?? "", "placement look");
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

describe("notifyReconnect lists every mailbox (D94)", () => {
  const reconnected = [
    "keithramos@trygetintroduced.info",
    "laurenrodriguez@trygetintroduced.info",
    "heatherortiz@trygetintroduced.info",
    "alexanderalvarez@usequickconnectsales.info",
    "nicolecollins@gogetintroduced.info",
    "samuelhoward@goquickconnectsales.info",
    "nicholaskelly@getintroducedpro.info",
    "kellycarter@goquickconnectsales.info",
    "dianewood@getintroducedhq.info",
    "sandrabailey@mygetintroduced.info",
    "sandrajohnson@myquickconnectsales.info",
    "joyceadams@getintroducedlab.info",
    "williamdiaz@getintroducedpro.info",
  ];
  const failed = [
    "sarah.morgan41@provascowarranty.info",
    "mia.collins37@labvascowarranty.info",
    "nicole.collins29@myvascowarranty.info",
    "ryan.brooks28@myvascowarranty.info",
    "rachel.collins27@usevascowarranty.info",
    "megan.collins25@usevascowarranty.info",
    "sarah.collins21@vascowarrantygo.info",
    "mia.parker17@govascowarranty.info",
    "nicole.parker9@tryvascowarranty.info",
    "ryan.carter8@tryvascowarranty.info",
    "rachel.parker7@vascowarrantyget.info",
    "megan.parker5@vascowarrantyget.info",
  ];

  it("posts all 13 reconnects and all 12 failures from the 2026-09-28 pass", async () => {
    const { client, sent } = capture();
    await client.notifyReconnect({
      scanned: 955,
      disconnected: 25,
      reconnected: reconnected.length,
      skippedAlreadyConnected: 0,
      failed: failed.length,
      inboxkitReexports: 0,
      errors: [],
      actions: [
        ...reconnected.map((email) => ({
          email,
          message: "reconnected",
          reauthenticated: true,
        })),
        ...failed.map((email) => ({
          email,
          message: "Failed to reconnect email account",
          reauthenticated: false,
        })),
      ],
    });
    assert.equal(sent.length, 1);
    const text = sent[0] ?? "";
    assert.match(text, /Reconnected 13:/);
    assert.match(text, /Couldn't reconnect 12/);
    for (const email of [...reconnected, ...failed]) {
      assert.match(text, new RegExp(email.replace(/\./g, "\\.")), email);
    }
    assert.doesNotMatch(text, /and \d+ more/);
    assertPlain(text, "reconnect full list");
  });

  it("names the leftover count instead of dropping rows past the Slack cap", () => {
    const items = Array.from(
      { length: RECONNECT_SLACK_LIST_CAP + 3 },
      (_, i) => `• \`box${i}@example.info\``,
    );
    const lines = slackReconnectBullets(items);
    assert.equal(lines.length, RECONNECT_SLACK_LIST_CAP + 1);
    assert.equal(lines.at(-1), "• …and 3 more");
    assert.ok(lines.includes("• `box0@example.info`"));
    assert.ok(!lines.includes(`• \`box${RECONNECT_SLACK_LIST_CAP}@example.info\``));
  });
});
