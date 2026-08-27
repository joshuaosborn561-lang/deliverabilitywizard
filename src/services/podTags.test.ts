import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { assignClientCohorts } from "../lib/restCohort.js";
import { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";
import { PodTagService, POD_TAG_A, POD_TAG_B } from "./podTags.js";

function bookWith(campaigns: unknown[], accounts: unknown[]): InventoryBook {
  return {
    get: async () => ({ campaigns, accounts, clients: [], fetchedAt: Date.now() }),
  } as unknown as InventoryBook;
}

describe("PodTagService (D135)", () => {
  it("converges POD-A/POD-B on client pod mailboxes and leaves generics alone", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-tags-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const emails = [
      "a@client.info",
      "b@client.info",
      "c@client.info",
      "d@client.info",
    ];
    const cohorts = assignClientCohorts(emails);
    const wrongTagFor = (email: string) =>
      cohorts.get(email) === "A" ? POD_TAG_B : POD_TAG_A;
    const rightTagFor = (email: string) =>
      cohorts.get(email) === "A" ? POD_TAG_A : POD_TAG_B;

    const accounts = [
      // carries the wrong pod tag — must be corrected
      {
        id: 1,
        from_email: emails[0],
        client_id: 9,
        campaign_ids: [50],
        tags: [{ tag_name: wrongTagFor(emails[0]!) }],
      },
      // carries the right tag already — no write
      {
        id: 2,
        from_email: emails[1],
        client_id: 9,
        campaign_ids: [50],
        tags: [{ tag_name: rightTagFor(emails[1]!) }],
      },
      // untagged — gets its pod tag
      { id: 3, from_email: emails[2], client_id: 9, campaign_ids: [50], tags: [] },
      { id: 4, from_email: emails[3], client_id: 9, campaign_ids: [50], tags: [] },
      // pre-warmed generic — never tagged by this converge
      {
        id: 5,
        from_email: "spare@cleartechco.com",
        client_id: null,
        campaign_ids: [50],
        tags: [],
      },
    ];
    const assigns: Array<[number[], number[]]> = [];
    const removes: Array<[number[], number[]]> = [];
    const smartlead = {
      ensureTag: async (name: string) => ({
        id: name === POD_TAG_A ? 71 : 72,
        name,
      }),
      assignTags: async (accountIds: number[], tagIds: number[]) => {
        assigns.push([accountIds, tagIds]);
      },
      removeTags: async (accountIds: number[], tagIds: number[]) => {
        removes.push([accountIds, tagIds]);
      },
    };
    const service = new PodTagService(
      loadConfig({} as NodeJS.ProcessEnv),
      smartlead as never,
      state,
      bookWith(
        [{ id: 50, name: "Client campaign", status: "ACTIVE", client_id: 9 }],
        accounts,
      ),
      async () => {},
    );

    const result = await service.run();
    // accounts 1, 3, 4 need their pod tag; account 1 also drops the wrong one
    assert.equal(result.assigned, 3);
    assert.equal(result.removed, 1);
    const tagIdFor = (email: string) =>
      cohorts.get(email) === "A" ? 71 : 72;
    const assignedPairs = assigns.flatMap(([ids, tags]) =>
      ids.map((id) => [id, tags[0]] as const),
    );
    assert.deepEqual(
      assignedPairs.sort((x, y) => x[0] - y[0]),
      [
        [1, tagIdFor(emails[0]!)],
        [3, tagIdFor(emails[2]!)],
        [4, tagIdFor(emails[3]!)],
      ],
    );
    const removedPairs = removes.flatMap(([ids, tags]) =>
      ids.map((id) => [id, tags[0]] as const),
    );
    assert.deepEqual(removedPairs, [[1, tagIdFor(emails[0]!) === 71 ? 72 : 71]]);
    assert.ok(
      !assignedPairs.some(([id]) => id === 5),
      "the generic mailbox is not pod-tagged",
    );
  });

  it("a fully converged fleet writes nothing, not even the tag ensure", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-tags-clean-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const emails = ["a@client.info", "b@client.info"];
    const cohorts = assignClientCohorts(emails);
    const accounts = emails.map((email, i) => ({
      id: i + 1,
      from_email: email,
      client_id: 9,
      campaign_ids: [50],
      tags: [{ tag_name: cohorts.get(email) === "A" ? POD_TAG_A : POD_TAG_B }],
    }));
    let ensured = 0;
    const smartlead = {
      ensureTag: async (name: string) => {
        ensured += 1;
        return { id: 1, name };
      },
      assignTags: async () => {
        throw new Error("no writes expected");
      },
      removeTags: async () => {
        throw new Error("no writes expected");
      },
    };
    const service = new PodTagService(
      loadConfig({} as NodeJS.ProcessEnv),
      smartlead as never,
      state,
      bookWith(
        [{ id: 50, name: "Client campaign", status: "ACTIVE", client_id: 9 }],
        accounts,
      ),
      async () => {},
    );
    const result = await service.run();
    assert.deepEqual(result, { assigned: 0, removed: 0 });
    assert.equal(ensured, 0, "drift-only: nothing ensured when nothing changes");
  });
});
