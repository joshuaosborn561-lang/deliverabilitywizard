import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { BCP_CLIENT_ID, TECHEVO_CLIENT_ID } from "./namedClientIds.js";
import {
  countOwnedClientPods,
  formatPodFloorAlert,
  seatSitsOnForeignNamedCampaign,
} from "./podOwnedInventory.js";
import { StateStore } from "../state/store.js";

const warmedAt = "2026-01-01T00:00:00.000Z";

function stateFile(): string {
  return `/tmp/pod-owned-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function namedSeat(input: {
  id: number;
  email: string;
  clientId: number;
  pod?: "A" | "B";
  campaignIds?: number[];
  fromName?: string;
}) {
  return {
    id: input.id,
    from_email: input.email,
    from_name: input.fromName ?? "Ada Lovelace",
    client_id: input.clientId,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    message_per_day: 30,
    created_at: warmedAt,
    campaign_ids: input.campaignIds ?? [],
    tags: input.pod ? [{ tag_name: `POD-${input.pod}` }] : [],
  };
}

function genericSeat(input: {
  id: number;
  email: string;
  clientId?: number | null;
  pod?: "A" | "B";
  campaignIds?: number[];
}) {
  return {
    id: input.id,
    from_email: input.email,
    from_name: "Pool User",
    client_id: input.clientId ?? null,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    message_per_day: 30,
    created_at: warmedAt,
    campaign_ids: input.campaignIds ?? [],
    tags: [
      { tag_name: "GENERIC" },
      ...(input.pod ? [{ tag_name: `POD-${input.pod}` }] : []),
    ],
  };
}

describe("podOwnedInventory (D285)", () => {
  it("ignores named seats sitting on another client's campaigns", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const config = loadConfig({});
    const borrowed = namedSeat({
      id: 1,
      email: "borrowed@techevolution.com",
      clientId: TECHEVO_CLIENT_ID,
      pod: "A",
      campaignIds: [99],
    });
    const owned = namedSeat({
      id: 2,
      email: "kept@techevolution.com",
      clientId: TECHEVO_CLIENT_ID,
      pod: "A",
      campaignIds: [20],
    });
    const rows = countOwnedClientPods({
      accounts: [borrowed, owned],
      campaigns: [
        { id: 20, name: "TechEvo A", status: "ACTIVE", client_id: TECHEVO_CLIENT_ID },
        { id: 99, name: "Goliath live", status: "ACTIVE", client_id: 548611 },
      ],
      config,
      state,
      clientIds: [TECHEVO_CLIENT_ID],
    });
    const podA = rows.find((row) => row.clientId === TECHEVO_CLIENT_ID && row.pod === "A");
    assert.equal(podA?.named, 1, "borrowed TechEvo seat on Goliath must not count");
    assert.equal(podA?.owned, 1);
    assert.equal(podA?.floor, 30);
    assert.equal(podA?.shortBy, 29);
  });

  it("counts assigned generics for that client and POD, not a foreign assignment", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const config = loadConfig({});
    state.ensureGenericSeat({
      email: "mine@crosslaunchco.com",
      slAccountId: 900,
    });
    state.assignGenericFromTable({
      email: "mine@crosslaunchco.com",
      clientId: BCP_CLIENT_ID,
      pod: "B",
      reason: "pod_top_up",
    });
    const mine = genericSeat({
      id: 900,
      email: "mine@crosslaunchco.com",
      clientId: BCP_CLIENT_ID,
      pod: "B",
      campaignIds: [],
    });
    const foreign = genericSeat({
      id: 901,
      email: "other@crosslaunchco.com",
      clientId: 548611,
      pod: "B",
      campaignIds: [99],
    });
    const rows = countOwnedClientPods({
      accounts: [mine, foreign],
      campaigns: [
        { id: 10, name: "BCP live", status: "ACTIVE", client_id: BCP_CLIENT_ID },
        { id: 99, name: "Goliath live", status: "ACTIVE", client_id: 548611 },
      ],
      config,
      state,
      clientIds: [BCP_CLIENT_ID],
    });
    const podB = rows.find((row) => row.clientId === BCP_CLIENT_ID && row.pod === "B");
    assert.equal(podB?.generics, 1);
    assert.equal(podB?.owned, 1);
  });

  it("Insight counts Josh-only seats; Owen does not fill the POD", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const config = loadConfig({});
    const josh = namedSeat({
      id: 1,
      email: "josh@trysalesglider.info",
      clientId: 582890,
      pod: "A",
      campaignIds: [3921647],
      fromName: "Josh Osborn",
    });
    const owen = namedSeat({
      id: 2,
      email: "owen@joshosbornhq.info",
      clientId: 582890,
      pod: "A",
      campaignIds: [3921647],
      fromName: "Owen Sanchez",
    });
    const rows = countOwnedClientPods({
      accounts: [josh, owen],
      campaigns: [
        {
          id: 3921647,
          name: "Insight Consolidation Gateway SEG",
          status: "ACTIVE",
          client_id: 582890,
        },
      ],
      config,
      state,
      clientIds: [582890],
    });
    const podA = rows.find((row) => row.clientId === 582890 && row.pod === "A");
    assert.equal(podA?.named, 1);
    assert.equal(podA?.owned, 1);
    assert.equal(podA?.floor, 40);
    assert.equal(podA?.shortBy, 39);
    assert.match(
      formatPodFloorAlert(podA!, "Insight"),
      /Insight POD-A is under floor: owned 1, need 40 \(short 39\)/,
    );
  });

  it("TechEvo floor is 30 per POD", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const config = loadConfig({});
    const named = Array.from({ length: 30 }, (_, i) =>
      namedSeat({
        id: 100 + i,
        email: `te${i}@techevolution.com`,
        clientId: TECHEVO_CLIENT_ID,
        pod: "A",
        campaignIds: [20],
      }),
    );
    const rows = countOwnedClientPods({
      accounts: named,
      campaigns: [
        { id: 20, name: "TechEvo A", status: "ACTIVE", client_id: TECHEVO_CLIENT_ID },
      ],
      config,
      state,
      clientIds: [TECHEVO_CLIENT_ID],
    });
    const podA = rows.find((row) => row.pod === "A");
    const podB = rows.find((row) => row.pod === "B");
    assert.equal(podA?.owned, 30);
    assert.equal(podA?.shortBy, 0);
    assert.equal(podA?.floor, 30);
    assert.equal(podB?.owned, 0);
    assert.equal(podB?.shortBy, 30);
  });

  it("seatSitsOnForeignNamedCampaign skips shells and same-client links", () => {
    const campaignById = new Map([
      [1, { id: 1, client_id: TECHEVO_CLIENT_ID, name: "TechEvo A" }],
      [2, { id: 2, client_id: 548611, name: "Goliath A" }],
      [3, { id: 3, client_id: 345263, name: "Canary shell: #1" }],
    ]);
    assert.equal(
      seatSitsOnForeignNamedCampaign({
        campaignIds: [1, 3],
        ownerClientId: TECHEVO_CLIENT_ID,
        campaignById,
      }),
      false,
    );
    assert.equal(
      seatSitsOnForeignNamedCampaign({
        campaignIds: [1, 2],
        ownerClientId: TECHEVO_CLIENT_ID,
        campaignById,
      }),
      true,
    );
  });
});
