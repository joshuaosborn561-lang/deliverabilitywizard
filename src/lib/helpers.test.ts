import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkArray, uniqueStrings } from "./http.js";
import { extractSenderEmails, pickSequence } from "../clients/smartlead.js";
import {
  asBlacklistRows,
  domainFromEmail,
  normalizeTestList,
  parseDomainBlacklistHits,
  parseIpBlacklistHits,
  uniqueBlacklistedDomains,
} from "../clients/smartdelivery.js";

describe("chunkArray", () => {
  it("splits mailboxes into batches of at most 50", () => {
    const emails = Array.from({ length: 120 }, (_, i) => `user${i}@example.com`);
    const batches = chunkArray(emails, 50);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]!.length, 50);
    assert.equal(batches[1]!.length, 50);
    assert.equal(batches[2]!.length, 20);
  });

  it("keeps small lists as a single batch", () => {
    const batches = chunkArray(["a@x.com", "b@x.com"], 50);
    assert.deepEqual(batches, [["a@x.com", "b@x.com"]]);
  });
});

describe("uniqueStrings", () => {
  it("dedupes case-insensitively", () => {
    assert.deepEqual(uniqueStrings(["A@x.com", "a@x.com", " b@x.com ", ""]), [
      "A@x.com",
      "b@x.com",
    ]);
  });
});

describe("extractSenderEmails / pickSequence", () => {
  it("prefers from_email then email then username", () => {
    const emails = extractSenderEmails([
      { id: 1, from_email: "one@example.com" },
      { id: 2, email: "two@example.com" },
      { id: 3, username: "three@example.com" },
    ]);
    assert.deepEqual(emails, [
      "one@example.com",
      "two@example.com",
      "three@example.com",
    ]);
  });

  it("picks requested sequence number", () => {
    const seq = pickSequence(
      [
        { id: 10, seq_number: 1, subject: "First" },
        { id: 20, seq_number: 2, subject: "Second" },
      ],
      2,
    );
    assert.equal(seq?.id, 20);
  });
});

describe("SmartDelivery helpers", () => {
  it("normalizes test list payloads", () => {
    assert.equal(normalizeTestList([{ id: 1 }]).length, 1);
    assert.equal(normalizeTestList({ data: [{ id: 2 }] }).length, 1);
    assert.equal(normalizeTestList({}).length, 0);
  });

  it("normalizes blacklist payloads", () => {
    assert.equal(
      asBlacklistRows([{ domain: "a.com", total_blacklist: 1 }]).length,
      1,
    );
    assert.equal(asBlacklistRows({ result: [{ domain: "b.com" }] }).length, 1);
    assert.equal(asBlacklistRows({}).length, 0);
  });
});

describe("domain blacklist callouts", () => {
  it("extracts sending domain from email", () => {
    assert.equal(
      domainFromEmail("pedro@parlaytechlab.info"),
      "parlaytechlab.info",
    );
    assert.equal(domainFromEmail("Bad@Input.COM"), "input.com");
    assert.equal(domainFromEmail("nope"), undefined);
  });

  it("calls out specifically blacklisted sending domains from domain-blacklist API", () => {
    const hits = parseDomainBlacklistHits([
      {
        from_email: "pedrokemmer@parlaytechlab.info",
        seed_accounts: [
          { email: "seed1@gmail.com", esp: "Gmail", domain_blacklisted: true },
          {
            email: "seed2@outlook.com",
            esp: "Outlook",
            domain_blacklisted: false,
          },
        ],
      },
      {
        from_email: "clean@healthy-domain.com",
        seed_accounts: [
          { email: "seed3@yahoo.com", esp: "Yahoo", domain_blacklisted: false },
        ],
      },
      {
        from_email: "john@parlaytechhub.info",
        seed_accounts: [
          { email: "seed4@gmail.com", esp: "Gmail", domain_blacklisted: true },
        ],
      },
    ]);

    assert.deepEqual(uniqueBlacklistedDomains(hits), [
      "parlaytechlab.info",
      "parlaytechhub.info",
    ]);
    assert.equal(hits[0]?.fromEmail, "pedrokemmer@parlaytechlab.info");
  });

  it("attributes IP blacklist hits to the sender domain, not the seed ESP domain", () => {
    const hits = parseIpBlacklistHits([
      {
        reply: { from_email: "sender@mybrand.io" },
        to_email: "seed@gmail.com",
        domain: "gmail.com",
        blacklist_type_value: "spamhaus",
        total_blacklist: 2,
        ip: "1.2.3.4",
        details: "IP listed on Spamhaus",
      },
      {
        reply: { from_email: "ok@safe.com" },
        domain: "gmail.com",
        total_blacklist: 0,
        details: "IP not listed",
      },
    ]);

    assert.deepEqual(uniqueBlacklistedDomains(hits), ["mybrand.io"]);
    assert.equal(hits[0]?.ip, "1.2.3.4");
    assert.equal(hits[0]?.listName, "spamhaus");
  });
});

describe("quota gate math", () => {
  it("blocks when needed tests exceed remaining quota", () => {
    const used = 110;
    const quota = 120;
    const mailboxCounts = [45, 60];
    const needed = mailboxCounts
      .map((n) => Math.ceil(n / 50))
      .reduce((a, b) => a + b, 0);
    const remaining = Math.max(0, quota - used);
    assert.equal(needed, 3);
    assert.equal(remaining, 10);
    assert.equal(needed > remaining, false);

    const tightUsed = 118;
    assert.equal(needed > Math.max(0, quota - tightUsed), true);
  });
});

describe("sender inbox rate parsing", () => {
  it("reads avg_inbox_rate from sender-account-wise payloads", async () => {
    const { parseSenderInboxRates } = await import("../clients/smartdelivery.js");
    const rows = parseSenderInboxRates([
      {
        email: "a@brand.com",
        details: { avg_inbox_rate: 72.5 },
      },
      {
        email: "b@brand.com",
        details: { avg_inbox_rate: 91 },
      },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.inboxRate, 72.5);
    const recover = rows.filter((r) => r.inboxRate < 80).map((r) => r.email);
    assert.deepEqual(recover, ["a@brand.com"]);
  });

  it("computes inbox rate from seed mail_folder details arrays", async () => {
    const { parseSenderInboxRates } = await import("../clients/smartdelivery.js");
    const rows = parseSenderInboxRates([
      {
        email: "spammy@brand.com",
        details: [
          { reply: { mail_folder: "Spam" } },
          { reply: { mail_folder: "Spam" } },
          { reply: { mail_folder: "Inbox" } },
          { reply: { mail_folder: "Spam" } },
        ],
      },
      {
        email: "healthy@brand.com",
        details: [
          { reply: { mail_folder: "Inbox" } },
          { reply: { mail_folder: "Inbox" } },
          { reply: { mail_folder: "Inbox" } },
          { reply: { mail_folder: "Spam" } },
        ],
      },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.inboxRate, 25);
    assert.equal(rows[1]?.inboxRate, 75);
    assert.deepEqual(
      rows.filter((r) => r.inboxRate < 80).map((r) => r.email),
      ["spammy@brand.com", "healthy@brand.com"],
    );
  });

  it("scores Gmail senders on G Suite seeds only (same-ESP)", async () => {
    const { parseSenderInboxRates } = await import("../clients/smartdelivery.js");
    const googleAuth = {
      spf_result: { spf: "google.com: domain of a@brand.com" },
      dkim_result: { dkim: "mx.google.com; dkim=pass" },
    };
    const outlookAuth = {
      spf_result: {
        spf: "Pass (protection.outlook.com: domain of brand.com)",
      },
      dkim_result: { dkim: "protection.outlook.com; dkim=pass" },
    };
    const rows = parseSenderInboxRates(
      [
        {
          email: "gmail-sender@brand.com",
          details: [
            { reply: { mail_folder: "Inbox", ...googleAuth } },
            { reply: { mail_folder: "Inbox", ...googleAuth } },
            { reply: { mail_folder: "Inbox", ...googleAuth } },
            { reply: { mail_folder: "Spam", ...outlookAuth } },
            { reply: { mail_folder: "Spam", ...outlookAuth } },
            { reply: { mail_folder: "Spam", ...outlookAuth } },
          ],
        },
      ],
      "t1",
      {
        senderTypeByEmail: new Map([["gmail-sender@brand.com", "GMAIL"]]),
        preferSameEsp: true,
        minSameEspSamples: 3,
      },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.inboxRateAll, 50);
    assert.equal(rows[0]?.inboxRateSameEsp, 100);
    assert.equal(rows[0]?.inboxRate, 100);
    assert.equal(rows[0]?.scoredSameEsp, true);
    assert.equal(rows[0]?.sameEspSamples, 3);
  });

  it("marks thin same-ESP samples as not placement-eligible (blended is display-only)", async () => {
    const { parseSenderInboxRates } = await import("../clients/smartdelivery.js");
    const { shouldRotateForPlacement } = await import("./placementRotation.js");
    const googleAuth = {
      dkim_result: { dkim: "mx.google.com; dkim=pass" },
    };
    const outlookAuth = {
      spf_result: { spf: "Pass (protection.outlook.com: domain of x.com)" },
    };
    const rows = parseSenderInboxRates(
      [
        {
          email: "outlook-sender@brand.com",
          details: [
            { reply: { mail_folder: "Spam", ...outlookAuth } },
            { reply: { mail_folder: "Inbox", ...googleAuth } },
            { reply: { mail_folder: "Inbox", ...googleAuth } },
            { reply: { mail_folder: "Inbox", ...googleAuth } },
          ],
        },
      ],
      undefined,
      {
        senderTypeByEmail: new Map([["outlook-sender@brand.com", "OUTLOOK"]]),
        preferSameEsp: true,
        minSameEspSamples: 3,
      },
    );
    assert.equal(rows[0]?.sameEspSamples, 1);
    assert.equal(rows[0]?.scoredSameEsp, false);
    // Blended % may still be exposed for display…
    assert.equal(rows[0]?.inboxRate, 75);
    // …but D32 forbids rotating on it.
    assert.equal(
      shouldRotateForPlacement(rows[0], 80, { scoreSameEspOnly: true }),
      false,
    );
  });

  it("computes inbox rate from inbox_count when avg is missing", async () => {
    const { parseSenderInboxRates } = await import("../clients/smartdelivery.js");
    const rows = parseSenderInboxRates({
      data: [
        {
          from_email: "low@brand.com",
          inbox_count: 2,
          adjusted_total_email_count: 10,
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.email, "low@brand.com");
    assert.equal(rows[0]?.inboxRate, 20);
  });

  it("computes hold-until date 28 days out in UTC", async () => {
    const { addDaysIsoDate } = await import("../services/remediation.js");
    assert.equal(addDaysIsoDate(new Date("2026-07-20T15:00:00Z"), 28), "2026-08-17");
    assert.equal(addDaysIsoDate(new Date("2026-01-31T12:00:00Z"), 28), "2026-02-28");
  });

  it("groups backfill actions by client with obvious counts", async () => {
    const { buildClientBackfillActions } = await import(
      "../services/remediation.js"
    );
    const actions = buildClientBackfillActions({
      deletedSmartleadAccounts: [
        {
          id: 1,
          email: "a@bad.example",
          domain: "bad.example",
          clientId: 10,
          clientName: "MSRS (Randy Gaines)",
        },
      ],
      purgedInboxKitDomains: ["bad.example"],
      recoveredInboxes: [
        {
          id: 2,
          email: "b@ok.example",
          inboxRate: 40,
          removedFromCampaigns: [100, 200],
          holdUntil: "2026-08-17",
          clientId: 10,
          clientName: "MSRS (Randy Gaines)",
        },
        {
          id: 3,
          email: "c@other.example",
          inboxRate: 10,
          removedFromCampaigns: [300],
          holdUntil: "2026-08-17",
          clientId: 20,
          clientName: "SalesGlider",
        },
      ],
      pausedCampaigns: [200],
    });

    assert.equal(actions.length, 2);
    const msrs = actions.find((a) => a.clientName.startsWith("MSRS"));
    assert.ok(msrs);
    assert.deepEqual(msrs!.domainsToReplace, ["bad.example"]);
    assert.equal(msrs!.inboxesToReplace, 1);
    assert.deepEqual(msrs!.pausedCampaignIds, [200]);
    const sg = actions.find((a) => a.clientName === "SalesGlider");
    assert.equal(sg!.inboxesToReplace, 1);
    assert.deepEqual(sg!.domainsToReplace, []);
  });
});
