import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { PodTagService } from "./podTags.js";

function fakeState(opts: {
  pool?: string[];
  canary?: string[];
} = {}): StateStore {
  const pool = new Set((opts.pool ?? []).map((email) => email.toLowerCase()));
  const canary = new Set((opts.canary ?? []).map((email) => email.toLowerCase()));
  return {
    getPoolMailbox: (email: string) =>
      pool.has(email.toLowerCase()) ? ({ email } as never) : undefined,
    isCopyCanary: (email: string) => canary.has(email.toLowerCase()),
    getDomainHistory: () => undefined,
  } as unknown as StateStore;
}

describe("PodTagService", () => {
  it("tags client mailboxes A/B and leaves generics alone", async () => {
    const assigned: Array<{ ids: number[]; tags: number[] }> = [];
    const removed: Array<{ ids: number[]; tags: number[] }> = [];
    const created: string[] = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "a@client.info",
          client_id: 9,
          campaign_ids: [1],
        },
        {
          id: 2,
          from_email: "z@client.info",
          client_id: 9,
          campaign_ids: [1],
        },
        {
          id: 3,
          from_email: "spare@crosslaunchco.com",
          client_id: 9,
          from_name: "Harmony Norris",
          campaign_ids: [1],
          tags: [{ tag_name: "POD-A" }],
        },
        {
          id: 4,
          from_email: "already@client.info",
          client_id: 9,
          campaign_ids: [1],
          tags: [{ tag_name: "POD-A" }],
        },
      ],
      listTags: async () => [],
      ensureTag: async (name: string) => {
        created.push(name);
        return { id: name === "POD-A" ? 11 : 12, name };
      },
      assignTags: async (ids: number[], tags: number[]) => {
        assigned.push({ ids, tags });
      },
      removeTags: async (ids: number[], tags: number[]) => {
        removed.push({ ids, tags });
      },
    } as unknown as SmartleadClient;

    const service = new PodTagService(
      loadConfig({
        EXTRA_GENERIC_MAILBOXES: "harmony norris",
        EXTRA_GENERIC_DOMAINS: "crosslaunchco.com",
      }),
      smartlead,
      fakeState({ pool: ["spare@crosslaunchco.com"] }),
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.strippedGeneric, 1);
    assert.ok(result.updated >= 2);
    assert.deepEqual(created.sort(), ["POD-A", "POD-B"]);
    assert.ok(removed.some((row) => row.ids.includes(3)));
    const taggedIds = assigned.flatMap((row) => row.ids);
    assert.ok(taggedIds.includes(1));
    assert.ok(taggedIds.includes(2));
    assert.equal(taggedIds.includes(3), false);
  });

  it("does not write in dry-run", async () => {
    let writes = 0;
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE", client_id: 9 },
      ],
      listAllEmailAccounts: async () => [
        { id: 1, from_email: "a@client.info", client_id: 9, campaign_ids: [1] },
        { id: 2, from_email: "z@client.info", client_id: 9, campaign_ids: [1] },
      ],
      listTags: async () => [
        { id: 11, name: "POD-A" },
        { id: 12, name: "POD-B" },
      ],
      ensureTag: async () => {
        writes += 1;
        return { id: 11, name: "POD-A" };
      },
      assignTags: async () => {
        writes += 1;
      },
      removeTags: async () => {
        writes += 1;
      },
    } as unknown as SmartleadClient;

    const result = await new PodTagService(
      loadConfig({}),
      smartlead,
      fakeState(),
    ).run({ dryRun: true });
    assert.ok(result.updated >= 1);
    assert.equal(writes, 0);
  });
});
