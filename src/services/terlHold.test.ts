import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { TerlHoldService } from "./terlHold.js";

const NOW = new Date("2026-10-02T18:00:00.000Z");
const AFTER = new Date("2026-10-03T18:00:00.000Z");
const EOD = new Date("2026-10-02T22:30:00.000Z");
const WARMED = new Date(Date.now() - 40 * 86_400_000).toISOString();
const COLD = new Date(Date.now() - 3 * 86_400_000).toISOString();

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-terl-hold-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

function config() {
  return loadConfig({ DRY_RUN: "false", MESSAGE_PER_DAY: "30" });
}

function inventory(opts: {
  includeSameClientGeneric?: boolean;
  includeForeignGeneric?: boolean;
  includeNamedIdle?: boolean;
  includeColdGeneric?: boolean;
} = {}) {
  const includeSameClientGeneric = opts.includeSameClientGeneric ?? true;
  const accounts: Array<Record<string, unknown>> = [
    {
      id: 10,
      type: "OUTLOOK",
      from_email: "ada@salesglider.com",
      from_name: "Ada Named",
      client_id: 345263,
      campaign_ids: [3847939],
      message_per_day: 15,
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      created_at: WARMED,
    },
  ];
  if (includeSameClientGeneric) {
    accounts.push({
      id: 20,
      type: "GMAIL",
      from_email: "casey@getintroduced.co",
      from_name: "Casey Pool",
      client_id: 345263,
      campaign_ids: [],
      message_per_day: 30,
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
      created_at: WARMED,
      warmup_details: { created_at: WARMED },
    });
  }
  if (opts.includeForeignGeneric) {
    accounts.push({
      id: 30,
      type: "GMAIL",
      from_email: "other@getintroduced.co",
      from_name: "Other Pool",
      client_id: 999001,
      campaign_ids: [],
      message_per_day: 30,
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
      created_at: WARMED,
      warmup_details: { created_at: WARMED },
    });
  }
  if (opts.includeNamedIdle) {
    accounts.push({
      id: 11,
      type: "OUTLOOK",
      from_email: "bert@salesglider.com",
      from_name: "Bert Named",
      client_id: 345263,
      campaign_ids: [],
      message_per_day: 15,
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "POD-A" }],
      created_at: WARMED,
    });
  }
  if (opts.includeColdGeneric) {
    accounts.push({
      id: 21,
      type: "GMAIL",
      from_email: "young@getintroduced.co",
      from_name: "Young Pool",
      client_id: 345263,
      campaign_ids: [],
      message_per_day: 30,
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "GENERIC" }, { tag_name: "POD-A" }],
      created_at: COLD,
      warmup_details: { created_at: COLD },
    });
  }
  return {
    accounts,
    campaigns: [
      {
        id: 3847939,
        name: "SG MSP Engagers",
        status: "ACTIVE",
        client_id: 345263,
      },
    ],
    clients: [{ id: 345263, name: "SalesGlider", logo: "SalesGlider" }],
    fetchedAt: NOW.getTime(),
  };
}

describe("TerlHoldService substitution (D219)", () => {
  it("swap-in: zeros the stopped seat, leaves it linked, links one same-client generic", async () => {
    const state = store();
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const linked: Array<{ campaignId: number; ids: number[] }> = [];
    const unlinked: Array<{ campaignId: number; ids: number[] }> = [];
    const tagWrites: number[] = [];
    const smartlead = {
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        if ("tags" in fields || "tag_ids" in fields) tagWrites.push(id);
        updates.push({ id, fields });
      },
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        linked.push({ campaignId, ids });
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        unlinked.push({ campaignId, ids });
      },
    };
    const service = new TerlHoldService(config(), smartlead, state);
    const result = await service.applyStops({
      domains: ["salesglider.com"],
      inventory: inventory({
        includeForeignGeneric: true,
        includeNamedIdle: true,
        includeColdGeneric: true,
      }) as never,
      dryRun: false,
      now: NOW,
    });

    assert.equal(result.zeroed, 1);
    assert.equal(result.substituted, 1);
    assert.equal(result.noSubstitute, 0);
    assert.deepEqual(
      updates.filter((row) => row.id === 10),
      [{ id: 10, fields: { max_email_per_day: 0 } }],
    );
    assert.deepEqual(linked, [{ campaignId: 3847939, ids: [20] }]);
    assert.deepEqual(unlinked, []);
    assert.deepEqual(tagWrites, []);
    const subUpdate = updates.find((row) => row.id === 20);
    assert.ok(subUpdate);
    assert.equal(subUpdate!.fields.signature, "Casey Pool\nSalesGlider");
    assert.equal(subUpdate!.fields.from_name, "Casey Pool");
    assert.equal(subUpdate!.fields.client_id, 345263);
    assert.equal(subUpdate!.fields.max_email_per_day, 30);
    assert.equal(
      updates.some((row) => row.id === 11 || row.id === 30 || row.id === 21),
      false,
      "named seats, foreign generics, and cold generics stay put",
    );

    const row = state.getTerlSubstitution(3847939, 10);
    assert.ok(row);
    assert.equal(row!.stoppedAccountId, 10);
    assert.equal(row!.stoppedEmail, "ada@salesglider.com");
    assert.equal(row!.substituteAccountId, 20);
    assert.equal(row!.substituteEmail, "casey@getintroduced.co");
    assert.equal(row!.campaignId, 3847939);
    assert.equal(row!.clientId, 345263);
    assert.equal(row!.stoppedAt, NOW.toISOString());
    assert.equal(row!.noSubstitute, false);
    assert.equal(row!.restoredAt, null);
    assert.equal(state.isTenantTerlHoldAccount(10, NOW), true);
  });

  it("swap-out: restores the type cap and unlinks the substitute after 24h", async () => {
    const state = store();
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const linked: Array<{ campaignId: number; ids: number[] }> = [];
    const unlinked: Array<{ campaignId: number; ids: number[] }> = [];
    const smartlead = {
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        linked.push({ campaignId, ids });
      },
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        ids: number[],
      ) => {
        unlinked.push({ campaignId, ids });
      },
    };
    const snap = inventory() as never;
    const service = new TerlHoldService(config(), smartlead, state);
    await service.applyStops({
      domains: ["salesglider.com"],
      inventory: snap,
      dryRun: false,
      now: NOW,
    });
    updates.length = 0;
    linked.length = 0;
    unlinked.length = 0;

    const stillHeld = await service.restoreExpired({
      inventory: snap,
      dryRun: false,
      now: new Date("2026-10-03T17:59:00.000Z"),
    });
    assert.equal(stillHeld.restored, 0);
    assert.deepEqual(unlinked, []);

    const done = await service.restoreExpired({
      inventory: snap,
      dryRun: false,
      now: AFTER,
    });
    assert.equal(done.restored, 1);
    assert.deepEqual(unlinked, [{ campaignId: 3847939, ids: [20] }]);
    assert.deepEqual(linked, []);
    assert.deepEqual(
      updates.filter((row) => row.id === 10),
      [{ id: 10, fields: { max_email_per_day: 15 } }],
    );
    const row = state.getTerlSubstitution(3847939, 10);
    assert.ok(row?.restoredAt);
    assert.equal(state.isTenantTerlHoldAccount(10, AFTER), false);
  });

  it("does not borrow another client's generic; EOD names the 39-sending campaign", async () => {
    const state = store();
    const notes: string[] = [];
    const linked: Array<{ campaignId: number; ids: number[] }> = [];
    const smartlead = {
      updateEmailAccount: async () => undefined,
      addEmailAccountsToCampaign: async (campaignId: number, ids: number[]) => {
        linked.push({ campaignId, ids });
      },
      removeEmailAccountsFromCampaign: async () => undefined,
    };
    const service = new TerlHoldService(config(), smartlead, state, {
      notifyDeliverabilityNote: async (text: string) => {
        notes.push(text);
      },
    });
    const result = await service.applyStops({
      domains: ["salesglider.com"],
      inventory: inventory({
        includeSameClientGeneric: false,
        includeForeignGeneric: true,
        includeNamedIdle: true,
        includeColdGeneric: true,
      }) as never,
      dryRun: false,
      now: NOW,
    });
    assert.equal(result.substituted, 0);
    assert.equal(result.noSubstitute, 1);
    assert.deepEqual(linked, []);
    const row = state.getTerlSubstitution(3847939, 10);
    assert.equal(row?.noSubstitute, true);
    assert.equal(row?.substituteAccountId, null);

    const posted = await service.postEodDigest({ now: EOD });
    assert.equal(posted.posted, true);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /\*SalesGlider\*/);
    assert.match(notes[0]!, /ada@salesglider\.com \(salesglider\.com\)/);
    assert.match(
      notes[0]!,
      /#3847939 SG MSP Engagers: no substitute available, at 39 sending/,
    );
    assert.equal(notes[0]!.includes("—"), false);
    assert.equal(notes[0]!.includes("–"), false);

    const weekend = await service.postEodDigest({
      now: new Date("2026-10-03T22:30:00.000Z"),
    });
    assert.equal(weekend.posted, false);
    assert.equal(notes.length, 1);
  });
});
