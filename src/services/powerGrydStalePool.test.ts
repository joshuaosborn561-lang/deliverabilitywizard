import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";
import { OneClientMembershipService } from "./oneClientMembership.js";
import type { InventorySnapshot } from "./inventory.js";

const NOW = new Date("2026-10-12T15:00:00.000Z");
const ON_WEEK = onWeekCohort(NOW);

const THRASHING = [
  {
    id: 11,
    email: "andreaadams@myoutreachdesk.info",
    clientId: 521881,
    brand: "TechEvolution",
    campaignId: 1001,
  },
  {
    id: 12,
    email: "brendaramirez@outreachdeskpro.info",
    clientId: 521881,
    brand: "TechEvolution",
    campaignId: 1001,
  },
  {
    id: 13,
    email: "brianbrown@usemeetconnect.info",
    clientId: 582890,
    brand: "Insight",
    campaignId: 2001,
  },
  {
    id: 14,
    email: "charlesharris@usemeetconnect.info",
    clientId: 582890,
    brand: "Insight",
    campaignId: 2001,
  },
  {
    id: 15,
    email: "christinaevans@getoutreachdesk.info",
    clientId: 582890,
    brand: "Insight",
    campaignId: 2001,
  },
] as const;

function padNamed(
  campaignId: number,
  clientId: number,
  domain: string,
  count: number,
  idStart: number,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: idStart + i,
    from_email: `pad-${i}@${domain}`,
    client_id: clientId,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: `POD-${ON_WEEK}` }],
    campaign_ids: [campaignId],
    created_at: "2026-01-01T00:00:00.000Z",
  }));
}

describe("D257 stale PowerGRYD pool vs live TechEvo/Insight", () => {
  it("pool=PG + SL=TE/Insight + PG empty-by-design: seats stay, PG stays at 0 senders", async () => {
    const state = new StateStore(
      `/tmp/pg-stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    await state.load();
    for (const row of THRASHING) {
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
    }

    const removed: Array<[number, number[]]> = [];
    const attached: Array<[number, number[]]> = [];
    const genericAccounts = THRASHING.map((row) => {
      const [local] = row.email.split("@") as [string];
      const fromName = local.replace(/([a-z])([A-Z])/g, "$1 $2");
      const pretty = fromName.replace(/([a-z])([a-z]+)/g, (_, a, b) => `${a.toUpperCase()}${b}`);
      return {
        id: row.id,
        from_email: row.email,
        from_name: pretty,
        signature: `${pretty}\n${row.brand}`,
        client_id: row.clientId,
        type: "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${ON_WEEK}` }],
        campaign_ids: [row.campaignId],
        created_at: "2026-01-01T00:00:00.000Z",
      };
    });
    const warmingPg = Array.from({ length: 8 }, (_, i) => ({
      id: 300 + i,
      from_email: `warm${i}@powergryd.com`,
      client_id: 592842,
      type: "GMAIL",
      is_smtp_success: true,
      is_imap_success: true,
      tags: [{ tag_name: `POD-${ON_WEEK}` }],
      campaign_ids: [],
      created_at: "2026-10-10T00:00:00.000Z",
    }));
    const inventory: InventorySnapshot = {
      fetchedAt: Date.now(),
      clients: [
        { id: 521881, name: "TechEvolution", logo: "TechEvolution" },
        { id: 582890, name: "Insight", logo: "Insight" },
        { id: 592842, name: "PowerGRYD", logo: "PowerGRYD" },
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      campaigns: [
        { id: 1001, name: "TechEvo NE", status: "ACTIVE", client_id: 521881 },
        { id: 2001, name: "Insight SEG", status: "ACTIVE", client_id: 582890 },
        { id: 3001, name: "PowerGRYD live", status: "ACTIVE", client_id: 592842 },
      ],
      accounts: [
        ...genericAccounts,
        // Keep the generics needed for each client's floor so surplus
        // return does not unlink them (TE floor 30, Insight 40).
        ...padNamed(1001, 521881, "techevolution.com", 28, 500),
        ...padNamed(2001, 582890, "joshosbornhq.info", 37, 800),
        ...warmingPg,
      ],
    };

    const config = loadConfig({
      DRY_RUN: "false",
      AUTO_ALLOW_GENERIC_CLIENT_IDS: "521881,582890,592842,542838,418274,574020",
    });
    const smartlead = {
      addEmailAccountsToCampaign: async (id: number, ids: number[]) => {
        attached.push([id, [...ids]]);
      },
      removeEmailAccountsFromCampaign: async (id: number, ids: number[]) => {
        removed.push([id, [...ids]]);
      },
      updateEmailAccount: async () => undefined,
      ensureTag: async (name: string) => ({ id: 99, name }),
      assignTags: async () => undefined,
    } as unknown as SmartleadClient;
    const slack = {
      send: async () => undefined,
      notifyIsolationAction: async () => undefined,
      notifyGenericBackfillBatch: async () => undefined,
    } as unknown as SlackClient;

    const oneClient = new OneClientMembershipService(config, smartlead, state);
    const one = await oneClient.run({ dryRun: false, inventory });
    assert.equal(
      one.pulled.length,
      0,
      `one-client must not peel TE/Insight seats: ${JSON.stringify(one.pulled)}`,
    );
    assert.deepEqual(removed, []);

    const min40 = new Min40TopUpService(config, smartlead, slack, state);
    const top = await min40.run({ dryRun: false, inventory, now: NOW });
    assert.equal(
      attached.some((row) => row[0] === 3001),
      false,
      `min40 must not link anyone onto PowerGRYD: ${JSON.stringify(attached)}`,
    );
    assert.equal(
      top.assigned.some((row) => row.clientId === 592842),
      false,
      `min40 must not assign onto PowerGRYD: ${JSON.stringify(top.assigned)}`,
    );

    for (const row of THRASHING) {
      const account = inventory.accounts.find(
        (item) =>
          String(
            (item as { from_email?: string }).from_email ?? "",
          ).toLowerCase() === row.email,
      ) as { campaign_ids?: number[] } | undefined;
      assert.ok(account, row.email);
      assert.deepEqual(
        account.campaign_ids,
        [row.campaignId],
        `${row.email} must stay on its TechEvo/Insight campaign`,
      );
      assert.equal(
        state.getPoolMailbox(row.email)?.assignedClientId,
        row.clientId,
        `${row.email} pool row must realign to live Smartlead client_id`,
      );
    }

    const pgSenders = inventory.accounts.filter((item) => {
      const ids = (item as { campaign_ids?: number[] }).campaign_ids ?? [];
      return ids.includes(3001);
    });
    assert.equal(pgSenders.length, 0, "PowerGRYD stays at 0 senders");
  });
});
