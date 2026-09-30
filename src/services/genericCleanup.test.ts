import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { GenericCleanupService } from "./genericCleanup.js";

function stateFile(): string {
  return `/tmp/genclean-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("GenericCleanupService (D205)", () => {
  it("clears client_id + signature when a GENERIC is off that client's ACTIVE campaigns", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 521881, name: "TechEvo", logo: "TechEvolution" }],
        campaigns: [
          { id: 1, name: "TechEvo A", status: "PAUSED", client_id: 521881 },
          { id: 2, name: "TechEvo B", status: "ACTIVE", client_id: 521881 },
        ],
        accounts: [
          {
            id: 10,
            from_email: "gone@pool.info",
            client_id: 521881,
            signature: "Ada Lovelace\nTechEvolution",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [1],
          },
          {
            id: 11,
            from_email: "live@pool.info",
            client_id: 521881,
            signature: "Ada Lovelace\nTechEvolution",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [2],
          },
          {
            id: 12,
            from_email: "named@techevolution.com",
            client_id: 521881,
            signature: "Named Seat\nTechEvolution",
            campaign_ids: [1],
          },
          {
            id: 13,
            from_email: "pg@pool.info",
            client_id: 592842,
            signature: "Pat\nPowerGRYD",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [],
          },
        ],
      },
    });
    assert.deepEqual(writes, [{ id: 10, fields: { client_id: null, signature: "" } }]);
    assert.equal(result.cleared.length, 1);
    assert.equal(result.cleared[0]?.email, "gone@pool.info");
  });

  it("D209: CultureFits generic still on two ACTIVE camps of that client is not cleared", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new GenericCleanupService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({
      dryRun: false,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" }],
        campaigns: [
          { id: 3763799, name: "BCP HC With Team", status: "ACTIVE", client_id: 542838 },
          { id: 3763800, name: "BCP HC No Team", status: "ACTIVE", client_id: 542838 },
        ],
        accounts: [
          {
            id: 11,
            from_email: "ada@useculturefits.info",
            client_id: 542838,
            signature: "Ada Pool\nBolder Cyber Partners",
            tags: [{ tag_name: "GENERIC" }],
            campaign_ids: [3763799, 3763800],
          },
        ],
      },
    });
    assert.deepEqual(writes, []);
    assert.equal(result.cleared.length, 0);
  });
});
