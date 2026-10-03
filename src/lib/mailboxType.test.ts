import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AZURE_CAMPAIGN_PER_DAY,
  AZURE_WARMUP_PER_DAY,
  M365_CAMPAIGN_PER_DAY,
  TYPE_TAG,
  classifyMailboxSendType,
  mailboxTypeCampaignCap,
  mailboxTypeWarmupCap,
} from "./mailboxType.js";

const caps = { messagePerDay: 30, warmupTotalPerDay: 20 };

describe("classifyMailboxSendType (D219)", () => {
  it("tags tidalstackco.com as Azure even when Smartlead type is OUTLOOK", () => {
    assert.equal(
      classifyMailboxSendType({
        type: "OUTLOOK",
        from_email: "ada@tidalstackco.com",
      }),
      "azure",
    );
  });

  it("honors an existing type:azure tag on another domain", () => {
    assert.equal(
      classifyMailboxSendType({
        type: "OUTLOOK",
        from_email: "ada@other.com",
        tags: [{ tag_name: TYPE_TAG.azure }],
      }),
      "azure",
    );
  });

  it("reads other Microsoft seats as m365 and Gmail as google", () => {
    assert.equal(
      classifyMailboxSendType({
        type: "OUTLOOK",
        from_email: "ada@salesglider.com",
      }),
      "m365",
    );
    assert.equal(
      classifyMailboxSendType({
        type: "GMAIL",
        from_email: "ada@gmail.com",
      }),
      "google",
    );
  });

  it("type tag wins over domain/ESP", () => {
    assert.equal(
      classifyMailboxSendType({
        type: "OUTLOOK",
        from_email: "ada@tidalstackco.com",
        tags: [{ tag_name: TYPE_TAG.m365 }],
      }),
      "m365",
    );
  });
});

describe("mailbox type caps (D219)", () => {
  it("Azure is 2 campaign + 5 warmup; M365 is 15 campaign; Google stays 30/20", () => {
    assert.equal(AZURE_CAMPAIGN_PER_DAY, 2);
    assert.equal(AZURE_WARMUP_PER_DAY, 5);
    assert.equal(M365_CAMPAIGN_PER_DAY, 15);
    assert.equal(
      mailboxTypeCampaignCap(
        { type: "OUTLOOK", from_email: "ada@tidalstackco.com" },
        caps,
      ),
      2,
    );
    assert.equal(
      mailboxTypeWarmupCap(
        { type: "OUTLOOK", from_email: "ada@tidalstackco.com" },
        caps,
      ),
      5,
    );
    assert.equal(
      mailboxTypeCampaignCap(
        { type: "OUTLOOK", from_email: "ada@salesglider.com" },
        caps,
      ),
      15,
    );
    assert.equal(
      mailboxTypeWarmupCap(
        { type: "OUTLOOK", from_email: "ada@salesglider.com" },
        caps,
      ),
      20,
    );
    assert.equal(
      mailboxTypeCampaignCap({ type: "GMAIL", from_email: "ada@x.com" }, caps),
      30,
    );
    assert.equal(
      mailboxTypeWarmupCap({ type: "GMAIL", from_email: "ada@x.com" }, caps),
      20,
    );
  });
});
