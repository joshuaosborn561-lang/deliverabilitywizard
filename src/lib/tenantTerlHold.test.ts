import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TERL_HOLD_MS,
  accountOnTenantTerlHold,
  terlEodDigestText,
  terlHoldActive,
  terlHeldUntil,
} from "./tenantTerlHold.js";

describe("tenant TERRL hold (D219)", () => {
  it("holds for 24 hours then does not invent an 80% cap", () => {
    const now = new Date("2026-10-03T15:00:00.000Z");
    const until = terlHeldUntil(now);
    assert.equal(until.getTime() - now.getTime(), TERL_HOLD_MS);
    assert.equal(terlHoldActive(until.toISOString(), now), true);
    assert.equal(
      terlHoldActive(until.toISOString(), new Date(until.getTime())),
      false,
    );
  });

  it("reads a live hold from the store by id or domain", () => {
    const now = new Date("2026-10-03T15:00:00.000Z");
    const store = {
      isTenantTerlHoldAccount: (id: number) => id === 9,
      isTenantTerlHoldDomain: (domain: string) => domain === "tidalstackco.com",
    };
    assert.equal(
      accountOnTenantTerlHold({ id: 9, from_email: "x@other.com" }, store, now),
      true,
    );
    assert.equal(
      accountOnTenantTerlHold(
        { id: 1, from_email: "ada@tidalstackco.com" },
        store,
        now,
      ),
      true,
    );
    assert.equal(
      accountOnTenantTerlHold({ id: 1, from_email: "ada@other.com" }, store, now),
      false,
    );
  });

  it("EOD digest groups by client and names no-sub campaigns", () => {
    const text = terlEodDigestText({
      inboxes: [
        {
          accountId: 2,
          email: "bob@salesglider.com",
          clientId: 345263,
          clientName: "SalesGlider",
          tenant: "salesglider.com",
          pausedAt: "2026-10-03T15:00:00.000Z",
        },
        {
          accountId: 1,
          email: "ada@tidalstackco.com",
          clientId: 345263,
          clientName: "SalesGlider",
          tenant: "tidalstackco.com",
          pausedAt: "2026-10-03T15:01:00.000Z",
        },
      ],
      shortages: [
        {
          campaignId: 3847939,
          campaignName: "SG MSP Engagers",
          clientId: 345263,
          clientName: "SalesGlider",
          sending: 39,
        },
      ],
    });
    assert.ok(text);
    assert.match(text, /Microsoft 550 5\.7\.233 holds today/);
    assert.match(text, /\*SalesGlider\*/);
    assert.match(text, /ada@tidalstackco\.com \(tidalstackco\.com\)/);
    assert.match(
      text,
      /#3847939 SG MSP Engagers: no substitute available, at 39 sending/,
    );
    assert.equal(text!.includes("—"), false);
    assert.equal(text!.includes("–"), false);
    assert.equal(text!.includes("80%"), false);
    assert.equal(terlEodDigestText({ inboxes: [], shortages: [] }), null);
  });
});
