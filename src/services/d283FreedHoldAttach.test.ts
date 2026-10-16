import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { GENERIC_ASSIGN_REASON_POWERGRYD } from "../lib/genericPool.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";
import { OneClientMembershipService } from "./oneClientMembership.js";
import { CampaignTopUpService } from "./campaignTopUp.js";
import type { InventorySnapshot } from "./inventory.js";

const NOW = new Date("2026-10-16T18:00:00.000Z");
const ON_WEEK = onWeekCohort(NOW);

function slack(): SlackClient {
  return {
    send: async () => undefined,
    notifyIsolationAction: async () => undefined,
  } as unknown as SlackClient;
}

describe("D283 freed PowerGRYD seats + CornerStone HOLD-UNTIL attach", () => {
  it("one-client / min40 do not write 592842 back onto Onboarding-freed generics", async () => {
    const state = new StateStore(
      `/tmp/d283-freed-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    for (const row of [
      {
        id: 21592200,
        email: "christinaevans@getoutreachdesk.info",
      },
      {
        id: 21592202,
        email: "charlesharris@usemeetconnect.info",
      },
    ] as const) {
      const [local, domain] = row.email.split("@") as [string, string];
      state.upsertPoolMailbox({
        email: row.email,
        domain,
        platform: "GOOGLE",
        smartleadAccountId: row.id,
        firstName: local,
        lastName: "Pool",
        status: "assigned",
        assignedClientId: 592842,
        assignedClientName: "PowerGRYD",
        warmedAt: "2026-01-01T00:00:00Z",
      });
      state.upsertGenericSeat({
        email: row.email,
        slAccountId: row.id,
        provider: "GOOGLE",
        warmReadyAt: "2026-01-01T00:00:00Z",
        assignedClientId: 592842,
        assignedCampaignIds: [],
        assignedPod: ON_WEEK,
        assignedAt: "2026-09-01T00:00:00Z",
        reason: GENERIC_ASSIGN_REASON_POWERGRYD,
        releasedAt: null,
        releaseHistory: [],
        staffableWeight: 1,
      });
    }

    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const attached: Array<[number, number[]]> = [];
    const accounts = [
      {
        id: 21592200,
        from_email: "christinaevans@getoutreachdesk.info",
        from_name: "Christina Evans",
        signature: "Christina Evans",
        client_id: null,
        type: "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${ON_WEEK}` }],
        campaign_ids: [],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 21592202,
        from_email: "charlesharris@usemeetconnect.info",
        from_name: "Charles Harris",
        signature: "Charles Harris",
        client_id: null,
        type: "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${ON_WEEK}` }],
        campaign_ids: [],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 300 + i,
        from_email: `warm${i}@powergryd.com`,
        client_id: 592842,
        type: "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: `POD-${ON_WEEK}` }],
        campaign_ids: [],
        created_at: "2026-10-10T00:00:00.000Z",
      })),
    ];
    const inventory: InventorySnapshot = {
      fetchedAt: Date.now(),
      clients: [
        { id: 592842, name: "PowerGRYD", logo: "PowerGRYD" },
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      campaigns: [
        { id: 3001, name: "PowerGRYD live", status: "ACTIVE", client_id: 592842 },
      ],
      accounts,
    };
    const smartlead = {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        attached.push([id, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      ensureTag: async (name: string) => ({ id: 99, name }),
      assignTags: async () => undefined,
    } as unknown as SmartleadClient;

    const one = await new OneClientMembershipService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
    ).run({ dryRun: false, inventory });
    assert.equal(
      updates.some((row) => row.fields.client_id === 592842),
      false,
      `one-client must not write PowerGRYD back: ${JSON.stringify(updates)} ${JSON.stringify(one)}`,
    );
    assert.equal(
      state.getPoolMailbox("christinaevans@getoutreachdesk.info")?.assignedClientId,
      null,
    );
    assert.equal(
      state.getGenericSeat("christinaevans@getoutreachdesk.info")?.reason,
      null,
    );

    const top = await new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      slack(),
      state,
    ).run({ dryRun: false, inventory, now: NOW });
    assert.equal(
      attached.some((row) => row[0] === 3001 && row[1].some((id) => id === 21592200 || id === 21592202)),
      false,
      `min40 must not link freed generics onto PowerGRYD: ${JSON.stringify(attached)}`,
    );
    assert.equal(
      top.assigned.some((row) => row.clientName === "PowerGRYD" && /getoutreachdesk|usemeetconnect/.test(row.email)),
      false,
    );
    assert.equal(
      updates.some((row) => row.fields.client_id === 592842),
      false,
      `min40 must not write client_id 592842: ${JSON.stringify(updates)}`,
    );
  });

  it("campaign top-up does not re-link CornerStone HOLD-UNTIL seats onto EMCOR/TechEvo", async () => {
    const state = new StateStore(
      `/tmp/d283-hold-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const attached: Array<[number, number[]]> = [];
    const teNamed = Array.from({ length: 20 }, (_, i) => ({
      id: 500 + i,
      from_email: `te${i}@techevolution.com`,
      client_id: 521881,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [4002],
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const emcorNamed = Array.from({ length: 20 }, (_, i) => ({
      id: 600 + i,
      from_email: `em${i}@getmesaco.info`,
      client_id: 574020,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [4001],
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const held = Array.from({ length: 3 }, (_, i) => ({
      id: 70 + i,
      from_email: `held${i}@cornerstoneearthworksmy.info`,
      from_name: "Owen Held",
      client_id: 574088,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: "HOLD-UNTIL-2026-12-31" }, { tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [],
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const inventory: InventorySnapshot = {
      fetchedAt: Date.now(),
      clients: [
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
        { id: 574020, name: "EMCOR", logo: "Emcor" },
        { id: 574088, name: "CornerStone", logo: "CornerStone Earthworks" },
      ],
      campaigns: [
        { id: 4001, name: "EMCOR Mesa", status: "ACTIVE", client_id: 574020 },
        { id: 4002, name: "TechEvo NE", status: "ACTIVE", client_id: 521881 },
      ],
      accounts: [...teNamed, ...emcorNamed, ...held],
    };
    const smartlead = {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        attached.push([id, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async () => undefined,
      updateEmailAccount: async () => undefined,
      setInsightJoshLinkContext: () => undefined,
    } as unknown as SmartleadClient;

    const min40 = await new Min40TopUpService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      slack(),
      state,
    ).run({ dryRun: false, inventory, now: NOW });
    const top = await new CampaignTopUpService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      slack(),
      state,
    ).run({ dryRun: false, inventory });

    const heldIds = [70, 71, 72];
    assert.equal(
      attached.some((row) => row[1].some((id) => heldIds.includes(id))),
      false,
      `CornerStone HOLD-UNTIL seats must not attach: ${JSON.stringify(attached)} ${JSON.stringify(min40.assigned)} ${JSON.stringify(top.assigned)}`,
    );
  });

  it("does not dump Onboarding-freed PowerGRYD generics onto Goliath", async () => {
    const state = new StateStore(
      `/tmp/d283-goliath-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "christinaevans@getoutreachdesk.info",
      domain: "getoutreachdesk.info",
      platform: "GOOGLE",
      smartleadAccountId: 21592200,
      firstName: "Christina",
      lastName: "Evans",
      status: "assigned",
      assignedClientId: 592842,
      assignedClientName: "PowerGRYD",
      warmedAt: "2026-01-01T00:00:00Z",
    });
    state.upsertGenericSeat({
      email: "christinaevans@getoutreachdesk.info",
      slAccountId: 21592200,
      provider: "GOOGLE",
      warmReadyAt: "2026-01-01T00:00:00Z",
      assignedClientId: 592842,
      assignedCampaignIds: [3001],
      assignedPod: ON_WEEK,
      assignedAt: "2026-09-01T00:00:00Z",
      reason: GENERIC_ASSIGN_REASON_POWERGRYD,
      releasedAt: null,
      releaseHistory: [],
      staffableWeight: 1,
    });
    const attached: Array<[number, number[]]> = [];
    const removed: Array<[number, number[]]> = [];
    const inventory: InventorySnapshot = {
      fetchedAt: Date.now(),
      clients: [
        { id: 592842, name: "PowerGRYD", logo: "PowerGRYD" },
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      campaigns: [
        { id: 3001, name: "PowerGRYD live", status: "ACTIVE", client_id: 592842 },
        { id: 5486, name: "Goliath live", status: "ACTIVE", client_id: 548611 },
      ],
      accounts: [
        {
          id: 21592200,
          from_email: "christinaevans@getoutreachdesk.info",
          from_name: "Christina Evans",
          signature: "Christina Evans",
          client_id: null,
          type: "GMAIL",
          is_smtp_success: true,
          is_imap_success: true,
          tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${ON_WEEK}` }],
          campaign_ids: [3001],
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const smartlead = {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        attached.push([id, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (id: number, ids: number[]) => {
        removed.push([id, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    await new OneClientMembershipService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
    ).run({ dryRun: false, inventory });

    assert.equal(
      attached.some((row) => row[0] === 5486),
      false,
      `freed PowerGRYD generics must not restore onto Goliath: ${JSON.stringify(attached)}`,
    );
    assert.equal(
      removed.some((row) => row[0] === 3001 && row[1].includes(21592200)),
      true,
      `leftover PowerGRYD links still peel: ${JSON.stringify(removed)}`,
    );
  });
});
