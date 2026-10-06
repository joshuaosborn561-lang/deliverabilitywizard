import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { EndPocService } from "./endPoc.js";

function stateFile(): string {
  return `/tmp/endpoc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

describe("EndPocService (D236)", () => {
  it("marks the client ended and returns reserved seats", async () => {
    const writes: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const removed: Array<[number, number[]]> = [];
    const state = new StateStore(stateFile());
    await state.load();
    const service = new EndPocService(
      loadConfig({ DRY_RUN: "false" }),
      {
        updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
          writes.push({ id, fields });
        },
        removeEmailAccountsFromCampaign: async (
          campaignId: number,
          ids: number[],
        ) => {
          removed.push([campaignId, [...ids]]);
        },
        ensureTag: async (name: string) => ({ id: name === "POC" ? 531428 : 1, name }),
        removeTags: async () => undefined,
      } as unknown as SmartleadClient,
      state,
    );
    const result = await service.run({
      clientId: 597783,
      dryRun: false,
      inventory: {
        fetchedAt: Date.now(),
        clients: [{ id: 597783, name: "Deep Roots", logo: "Deep Roots Capital" }],
        campaigns: [
          { id: 4084613, name: "Deep Roots A", status: "DRAFTED", client_id: 597783 },
        ],
        accounts: [
          {
            id: 10,
            from_email: "poc@getintroduced.info",
            client_id: 597783,
            signature: "Ada Lovelace\nDeep Roots Capital",
            tags: [{ tag_name: "GENERIC" }, { tag_name: "POC" }],
            campaign_ids: [4084613],
          },
        ],
      },
    });
    assert.equal(result.marked, true);
    assert.equal(result.clientId, 597783);
    assert.equal(state.isPocEnded(597783), true);
    assert.equal(result.released.length, 1);
    assert.deepEqual(removed, [[4084613, [10]]]);
    assert.ok(writes.some((row) => row.id === 10 && row.fields.client_id === null));
  });
});
