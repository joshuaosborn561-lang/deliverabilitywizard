import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import {
  ClientRestService,
  offWeekSweepOwnerId,
  offWeekSweepTargets,
  offWeekSweepAllowed,
  offWeekSweepFloor,
} from "./clientRest.js";
import { INSIGHT_CLIENT_ID } from "../lib/insightCampaigns.js";
import { TECHEVO_CLIENT_ID } from "../lib/namedClientIds.js";

const WARMED = "2025-01-01T00:00:00.000Z";
// ISO week 43 (NY) → block 1 → POD-B on, POD-A off.
const NOW = new Date("2026-10-21T17:00:00Z");
const CLIENT = 574020;

function seat(
  id: number,
  email: string,
  pod: "POD-A" | "POD-B",
  campaignIds: number[],
  extraTags: string[] = [],
  clientId: number | null = CLIENT,
): Record<string, unknown> {
  return {
    id,
    from_email: email,
    client_id: clientId,
    type: "GMAIL",
    campaign_ids: campaignIds,
    created_at: WARMED,
    is_smtp_success: true,
    is_imap_success: true,
    tags: [{ tag_name: pod }, ...extraTags.map((tag_name) => ({ tag_name }))],
  };
}

async function harness(
  accounts: Array<Record<string, unknown>>,
  campaigns: Array<Record<string, unknown>>,
) {
  const removed: Array<[number, number]> = [];
  const added: Array<[number, number]> = [];
  const state = new StateStore(
    `/tmp/client-rest-sweep-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  const smartlead = {
    listCampaigns: async () => campaigns,
    listAllEmailAccounts: async () => accounts,
    removeEmailAccountsFromCampaign: async (cid: number, ids: number[]) => {
      for (const id of ids) removed.push([cid, id]);
    },
    addEmailAccountsToCampaign: async (cid: number, ids: number[]) => {
      for (const id of ids) added.push([cid, id]);
    },
  } as unknown as SmartleadClient;
  const service = new ClientRestService(
    loadConfig({ ENABLE_CLIENT_REST: "true", DRY_RUN: "false" }),
    smartlead,
    { send: async () => undefined } as unknown as SlackClient,
    state,
  );
  return { service, removed, added, state };
}

describe("D298 off-week POD sweep", () => {
  it("unlinks an off-week POD (named + generics) from every ACTIVE campaign of the client, incl. a held seat", async () => {
    const campaigns = [
      { id: 1, name: "C1", status: "ACTIVE", client_id: CLIENT },
      { id: 2, name: "C2", status: "ACTIVE", client_id: CLIENT },
      { id: 3, name: "C3 restaffed", status: "ACTIVE", client_id: CLIENT },
      { id: 4, name: "C4 paused", status: "PAUSED", client_id: CLIENT },
      { id: 5, name: "Other client", status: "ACTIVE", client_id: 111 },
    ];
    const podB = Array.from({ length: 40 }, (_, i) =>
      seat(1000 + i, `b${i}@clientmail.info`, "POD-B", [1, 2, 3]),
    );
    const podANamed = Array.from({ length: 5 }, (_, i) =>
      seat(2000 + i, `a${i}@clientmail.info`, "POD-A", [3, 4]),
    );
    const podAGenerics = [
      seat(3001, "g1@outreachdesknow.com", "POD-A", [3, 4], ["GENERIC"]),
      seat(3002, "g2@boxoutreachdesk.com", "POD-A", [1, 3], [
        "GENERIC",
        "HOLD-UNTIL-2099-01-01",
      ]),
    ];
    const { service, removed, added } = await harness(
      [...podB, ...podANamed, ...podAGenerics],
      campaigns,
    );
    await service.run({ dryRun: false, now: NOW });

    const offIds = [...podANamed, ...podAGenerics].map((a) => a.id as number);
    for (const id of offIds) {
      const acct = [...podANamed, ...podAGenerics].find((a) => a.id === id)!;
      for (const cid of acct.campaign_ids as number[]) {
        const removedHere = removed.some(([c, a]) => c === cid && a === id);
        if (cid === 4) {
          assert.equal(removedHere, false, `PAUSED #4 keeps ${id} (D207)`);
        } else {
          assert.ok(removedHere, `off-week ${id} unlinked from ACTIVE #${cid}`);
        }
      }
    }
    for (const a of podB) {
      assert.ok(
        !removed.some(([, id]) => id === a.id),
        "on-week POD-B stays linked",
      );
    }
    assert.ok(
      !added.some(([, id]) => offIds.includes(id)),
      "off-week seats are never attached",
    );
  });

  it("sweep never unlinks from another client's campaign", async () => {
    const campaigns = [
      { id: 1, name: "C1", status: "ACTIVE", client_id: CLIENT },
      { id: 5, name: "Other client", status: "ACTIVE", client_id: 111 },
    ];
    const podB = Array.from({ length: 40 }, (_, i) =>
      seat(1000 + i, `b${i}@clientmail.info`, "POD-B", [1, 5]),
    );
    const stray = seat(4002, "s@outreachdeskbox.com", "POD-A", [1, 5], [
      "GENERIC",
      "HOLD-UNTIL-2099-01-01",
    ]);
    const { service, removed } = await harness(
      [...podB, stray],
      campaigns,
    );
    await service.run({ dryRun: false, now: NOW });
    assert.ok(removed.some(([c, id]) => c === 1 && id === 4002));
    assert.ok(!removed.some(([c, id]) => c === 5 && id === 4002));
  });

  it("helpers: owner from mailbox client_id or a single campaign client", () => {
    const byClient = new Map<number, number | null>([
      [1, CLIENT],
      [5, 111],
    ]);
    assert.equal(
      offWeekSweepOwnerId({ id: 1, client_id: null, campaign_ids: [1] } as never, byClient),
      CLIENT,
    );
    assert.equal(
      offWeekSweepOwnerId({ id: 1, client_id: null, campaign_ids: [1, 5] } as never, byClient),
      null,
    );
    const byId = new Map([
      [1, { id: 1, name: "C1", status: "ACTIVE", client_id: CLIENT }],
      [2, { id: 2, name: "C2", status: "STOPPED", client_id: CLIENT }],
    ]);
    assert.deepEqual(
      offWeekSweepTargets(
        { id: 9, campaign_ids: [1, 2, 7] } as never,
        CLIENT,
        byId as never,
        [],
      ),
      [1],
    );
  });

  async function sweepHeld(clientId: number, onWeek: number): Promise<boolean> {
    const campaigns = [{ id: 1, name: "C1", status: "ACTIVE", client_id: clientId }];
    const podB = Array.from({ length: onWeek }, (_, i) =>
      seat(1000 + i, `b${i}@clientmail.info`, "POD-B", [1], [], clientId),
    );
    const stray = seat(4002, "s@outreachdeskbox.com", "POD-A", [1], [
      "GENERIC",
      "HOLD-UNTIL-2099-01-01",
    ], clientId);
    const { service, removed } = await harness([...podB, stray], campaigns);
    await service.run({ dryRun: false, now: NOW });
    return !removed.some(([c, id]) => c === 1 && id === 4002);
  }

  it("guard: holds the sweep when the on-week POD is under 40", async () => {
    assert.equal(await sweepHeld(CLIENT, 39), true);
    assert.equal(await sweepHeld(CLIENT, 40), false);
  });

  it("guard: TechEvo floor is 30", async () => {
    assert.equal(await sweepHeld(TECHEVO_CLIENT_ID, 29), true);
    assert.equal(await sweepHeld(TECHEVO_CLIENT_ID, 30), false);
  });

  it("guard: Insight is never swept", async () => {
    assert.equal(await sweepHeld(INSIGHT_CLIENT_ID, 60), true);
  });

  it("guard helpers", () => {
    assert.equal(offWeekSweepFloor(CLIENT), 40);
    assert.equal(offWeekSweepFloor(TECHEVO_CLIENT_ID), 30);
    assert.equal(offWeekSweepAllowed(INSIGHT_CLIENT_ID, 999), false);
    assert.equal(offWeekSweepAllowed(CLIENT, 39), false);
    assert.equal(offWeekSweepAllowed(CLIENT, 40), true);
  });
});
