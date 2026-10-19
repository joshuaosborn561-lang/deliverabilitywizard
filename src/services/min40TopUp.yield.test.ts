import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { EVENT_LOOP_REPEAT_MS } from "../lib/freezeWatchdog.js";
import { countOwnedClientPods } from "../lib/podOwnedInventory.js";
import { syncGenericSeatsFromInventory } from "../lib/genericPoolCanon.js";
import {
  BCP_CLIENT_ID,
  EMCOR_CLIENT_ID,
  PARLAY_CLIENT_ID,
  PETERSON_CLIENT_ID,
  POWERGRYD_CLIENT_ID,
  TECHEVO_CLIENT_ID,
} from "../lib/namedClientIds.js";
import { INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID } from "../lib/insightCampaigns.js";
import { StateStore } from "../state/store.js";
import { Min40TopUpService } from "./min40TopUp.js";

/** Production 2026-10-19 min40 start line: campaigns=514 accounts=1690. */
const FLEET_CAMPAIGNS = 514;
const FLEET_ACCOUNTS = 1690;
const WARMED_AT = "2026-01-01T00:00:00.000Z";

const CLIENTS: Array<{
  id: number;
  name: string;
  domain: string;
  logo: string;
}> = [
  { id: BCP_CLIENT_ID, name: "Mike Trpkosh", domain: "boldercyperpartner.com", logo: "Bolder Cyber Partners" },
  { id: TECHEVO_CLIENT_ID, name: "Corey Tapper", domain: "techevolution.com", logo: "TechEvolution" },
  { id: PARLAY_CLIENT_ID, name: "Randy Haba", domain: "parlay.com", logo: "Parlay Tech" },
  { id: EMCOR_CLIENT_ID, name: "Myles McIntosh", domain: "getmesaco.info", logo: "Emcor" },
  { id: 419001, name: "Roger Nutter", domain: "nuttergroup.com", logo: "Nutter Group" },
  { id: INSIGHT_CLIENT_ID, name: "Insight", domain: "salesglider.com", logo: "Insight" },
  { id: POWERGRYD_CLIENT_ID, name: "PowerGRYD", domain: "powergryd.com", logo: "PowerGRYD" },
  { id: SALESGLIDER_CLIENT_ID, name: "SalesGlider", domain: "trysalesglider.info", logo: "SalesGlider" },
  { id: PETERSON_CLIENT_ID, name: "Kyle Peterson", domain: "roofsbypetersongo.info", logo: "Roofs by Peterson" },
  { id: 548611, name: "Goliath", domain: "goliathcybersecurity.com", logo: "Goliath Cybersecurity" },
];

function stateFile(): string {
  return `/tmp/min40-yield-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function watchEventLoopGaps(intervalMs = 10): {
  stop: () => { maxGap: number; ticks: number };
} {
  let last = Date.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return { maxGap, ticks };
    },
  };
}

function buildFleet(): {
  campaigns: Array<{
    id: number;
    name: string;
    status: string;
    client_id: number;
  }>;
  accounts: Array<Record<string, unknown>>;
  clients: Array<{ id: number; name: string; logo: string }>;
} {
  const campaigns: Array<{
    id: number;
    name: string;
    status: string;
    client_id: number;
  }> = [];
  for (let i = 0; i < FLEET_CAMPAIGNS; i += 1) {
    const client = CLIENTS[i % CLIENTS.length]!;
    campaigns.push({
      id: 10_000 + i,
      name: `${client.logo} Lane ${i}`,
      status: "ACTIVE",
      client_id: client.id,
    });
  }
  const campaignsByClient = new Map<number, number[]>();
  for (const campaign of campaigns) {
    const list = campaignsByClient.get(campaign.client_id) ?? [];
    list.push(campaign.id);
    campaignsByClient.set(campaign.client_id, list);
  }

  const accounts: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const namedPerClient = 80;
  for (const client of CLIENTS) {
    const ids = (campaignsByClient.get(client.id) ?? []).slice(0, 40);
    for (let n = 0; n < namedPerClient; n += 1) {
      const pod = n % 2 === 0 ? "A" : "B";
      const fromName =
        client.id === INSIGHT_CLIENT_ID ? "Josh Osborn" : `Named ${client.logo} ${n}`;
      accounts.push({
        id: nextId,
        from_email: `n${n}@${client.domain}`,
        from_name: fromName,
        client_id: client.id === INSIGHT_CLIENT_ID ? SALESGLIDER_CLIENT_ID : client.id,
        type: n % 3 === 0 ? "OUTLOOK" : "GMAIL",
        is_smtp_success: true,
        is_imap_success: true,
        message_per_day: 30,
        created_at: WARMED_AT,
        campaign_ids: ids,
        tags: [{ tag_name: `POD-${pod}` }],
      });
      nextId += 1;
    }
  }

  while (accounts.length < FLEET_ACCOUNTS) {
    const i = accounts.length;
    const pod = i % 2 === 0 ? "A" : "B";
    accounts.push({
      id: nextId,
      from_email: `g${i}@crosslaunchco.com`,
      from_name: "Pool User",
      client_id: null,
      type: i % 2 === 0 ? "GMAIL" : "OUTLOOK",
      is_smtp_success: true,
      is_imap_success: true,
      message_per_day: 30,
      created_at: WARMED_AT,
      campaign_ids: [],
      tags: [{ tag_name: "GENERIC" }, { tag_name: `POD-${pod}` }],
    });
    nextId += 1;
  }

  return {
    campaigns,
    accounts,
    clients: CLIENTS.map((row) => ({
      id: row.id,
      name: row.name,
      logo: row.logo,
    })),
  };
}

describe("D289 min40 fleet yield", () => {
  it("a 514×1690 owned-count + min40 dry-run stays under the freeze-watchdog 3s repeat", { timeout: 120_000 }, async () => {
    const fleet = buildFleet();
    assert.equal(fleet.campaigns.length, FLEET_CAMPAIGNS);
    assert.equal(fleet.accounts.length, FLEET_ACCOUNTS);

    const state = new StateStore(stateFile());
    await state.load();
    const config = loadConfig({ DRY_RUN: "true" });
    const clientIds = CLIENTS.map((row) => row.id);
    const watch = watchEventLoopGaps(10);

    const owned = await countOwnedClientPods({
      accounts: fleet.accounts as never,
      campaigns: fleet.campaigns,
      config,
      state,
      clientIds,
    });
    assert.ok(owned.length >= CLIENTS.length * 2);

    const seeded = await syncGenericSeatsFromInventory({
      existing: [],
      accounts: fleet.accounts as never,
      campaigns: fleet.campaigns,
      config,
      state,
      now: new Date("2026-10-19T18:00:00Z"),
    });
    state.replaceGenericSeats(seeded.seats);

    const service = new Min40TopUpService(
      config,
      {
        addEmailAccountsToCampaign: async () => undefined,
        updateEmailAccount: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
      } as unknown as SmartleadClient,
      {
        send: async () => undefined,
        notifyIsolationAction: async () => undefined,
      } as unknown as SlackClient,
      state,
    );
    const result = await service.run({
      dryRun: true,
      now: new Date("2026-10-19T18:12:00Z"),
      inventory: {
        fetchedAt: Date.now(),
        campaigns: fleet.campaigns,
        accounts: fleet.accounts as never,
        clients: fleet.clients,
      },
    });
    const { maxGap, ticks } = watch.stop();

    assert.ok(result.unfilled.length >= 0);
    assert.ok(
      ticks > 0,
      "setInterval must fire during the fleet min40 pass (walks must yield)",
    );
    assert.ok(
      maxGap < EVENT_LOOP_REPEAT_MS,
      `fleet min40 event-loop gap ${maxGap}ms must stay under watchdog repeat ${EVENT_LOOP_REPEAT_MS}ms`,
    );
  });
});
