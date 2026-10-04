import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANON_STAFFABLE_MIN,
  accountMatchesCampaignClient,
  canonStaffableVerdict,
  formatCanonStaffFloorDetail,
  isCanonStaffable,
  mailboxPodTag,
  seatIsOnWeekPod,
  summarizeCanonUnstaffable,
} from "./canonStaffable.js";
import { staffFloorForCampaign } from "./clientStaffFloor.js";
import { onWeekCohort } from "./restCohort.js";

const week40A = new Date("2026-10-01T17:00:00Z"); // ISO week 40, POD A on-week

function seat(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    from_email: "amy@salesglider.com",
    client_id: 345263,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    message_per_day: 30,
    tags: [{ tag_name: "POD-A" }, { tag_name: "type:google" }],
    warmup_details: { created_at: "2026-08-01T00:00:00.000Z" },
    ...overrides,
  };
}

describe("canonStaffable (D217)", () => {
  it("ISO week 40 is POD A on-week", () => {
    assert.equal(onWeekCohort(week40A), "A");
    assert.equal(mailboxPodTag(seat()), "A");
    assert.equal(seatIsOnWeekPod(seat(), week40A), true);
    assert.equal(
      seatIsOnWeekPod(seat({ tags: [{ tag_name: "POD-B" }] }), week40A),
      false,
    );
  });

  it("a connected on-week seat with mpd and warmup is staffable", () => {
    assert.equal(
      isCanonStaffable({
        account: seat(),
        email: "amy@salesglider.com",
        campaignClientId: 345263,
        now: week40A,
      }),
      true,
    );
  });

  it("false pages: 41 on-week staffable meets the 40 floor, not named-inventory 48", () => {
    assert.equal(CANON_STAFFABLE_MIN, 40);
    assert.equal(
      staffFloorForCampaign({ client_id: 345263, name: "SG PE" }, new Map(), "SalesGlider", new Map([["id:345263", 48]])),
      40,
      "live Canon floor is 40, not max(named on-week, 40)",
    );
    const staffable = 41;
    assert.equal(Math.max(0, 40 - staffable), 0);
  });

  it("miss: SMTP-fail Vasco seats are not staffable even when linked", () => {
    const linked = [
      ...Array.from({ length: 34 }, (_, i) =>
        seat({
          id: 100 + i,
          from_email: `ok${i}@techevolution.com`,
          client_id: 521881,
        }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        seat({
          id: 200 + i,
          from_email: `fail${i}@labvascowarranty.info`,
          client_id: 521881,
          type: "SMTP",
          is_smtp_success: false,
          is_imap_success: true,
        }),
      ),
    ];
    const verdicts = linked.map((account) =>
      canonStaffableVerdict({
        account,
        email: String(account.from_email),
        campaignClientId: 521881,
        now: week40A,
      }),
    );
    const ok = verdicts.filter((row) => row.ok).length;
    const counts = summarizeCanonUnstaffable(verdicts);
    assert.equal(ok, 34);
    assert.equal(counts.smtp_fail, 7);
    assert.equal(linked.length, 41);
    assert.ok(ok < CANON_STAFFABLE_MIN, "34 staffable of 41 linked must page");
    assert.match(
      formatCanonStaffFloorDetail({
        staffable: ok,
        linked: linked.length,
        unstaffable: counts,
      }),
      /on-week staffable 34\/40 \(linked 41; smtp_fail 7\)/,
    );
  });

  it("excludes mpd 0, off-week POD, foreign client, and readable under-warmed", () => {
    assert.equal(
      canonStaffableVerdict({
        account: seat({ message_per_day: 0 }),
        email: "amy@salesglider.com",
        campaignClientId: 345263,
        now: week40A,
      }).reasons.includes("mpd0"),
      true,
    );
    assert.equal(
      canonStaffableVerdict({
        account: seat({ tags: [{ tag_name: "POD-B" }] }),
        email: "amy@salesglider.com",
        campaignClientId: 345263,
        now: week40A,
      }).reasons.includes("off_week_pod"),
      true,
    );
    assert.equal(
      canonStaffableVerdict({
        account: seat({ client_id: 521881 }),
        email: "amy@salesglider.com",
        campaignClientId: 345263,
        now: week40A,
      }).reasons.includes("foreign_client"),
      true,
    );
    assert.equal(
      canonStaffableVerdict({
        account: seat({
          warmup_details: { created_at: "2026-09-28T00:00:00.000Z" },
        }),
        email: "amy@salesglider.com",
        campaignClientId: 345263,
        now: week40A,
      }).reasons.includes("under_warmed"),
      true,
    );
    assert.equal(
      accountMatchesCampaignClient({ client_id: 521881 }, 521881, null),
      true,
    );
    assert.equal(
      accountMatchesCampaignClient({ client_id: 99 }, 521881, 521881),
      true,
      "dedicated generic owner counts as the campaign client",
    );
  });

  it("unknown smtp/imap and missing warmup clock do not mass-unstaff", () => {
    const verdict = canonStaffableVerdict({
      account: seat({
        is_smtp_success: undefined,
        is_imap_success: undefined,
        warmup_details: null,
        created_at: undefined,
      }),
      email: "amy@salesglider.com",
      campaignClientId: 345263,
      now: week40A,
    });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.reasons, []);
  });

  it("D227: WARMUP-GATE-EXEMPT tidalstack 9/29 import is not under_warmed", () => {
    const now = new Date("2026-10-04T00:04:00Z");
    const account = seat({
      from_email: "ada@tidalstackco.com",
      type: "OUTLOOK",
      tags: [
        { tag_name: "POD-A" },
        { tag_name: "type:azure" },
        { tag_name: "WARMUP-GATE-EXEMPT" },
      ],
      warmup_details: { created_at: "2026-09-29T00:00:00.000Z" },
      created_at: "2026-09-29T00:00:00.000Z",
    });
    const verdict = canonStaffableVerdict({
      account,
      email: "ada@tidalstackco.com",
      campaignClientId: 345263,
      now,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reasons.includes("under_warmed"), false);
    assert.equal(
      canonStaffableVerdict({
        account: seat({
          from_email: "ada@tidalstackco.com",
          tags: [{ tag_name: "POD-A" }, { tag_name: "type:azure" }],
          warmup_details: { created_at: "2026-09-29T00:00:00.000Z" },
        }),
        email: "ada@tidalstackco.com",
        campaignClientId: 345263,
        now,
      }).reasons.includes("under_warmed"),
      true,
      "without the tag, a 9/29 Smartlead clock is still under 21 days",
    );
  });
});
