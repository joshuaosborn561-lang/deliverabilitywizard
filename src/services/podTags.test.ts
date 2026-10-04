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
      // carries the opposite pod tag — D234 must leave it alone
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

    const weekday = new Date("2026-10-05T14:00:00.000Z");
    const result = await service.run({ now: weekday });
    // D234 — account 1 already has a POD tag (even the "wrong" one): no write.
    // Untagged 3 and 4 get a first tag. Generic 5 is left alone.
    assert.equal(result.assigned, 2);
    assert.equal(result.removed, 0);
    assert.equal(result.refused, 0);
    const tagIdFor = (email: string) =>
      cohorts.get(email) === "A" ? 71 : 72;
    const assignedPairs = assigns.flatMap(([ids, tags]) =>
      ids.map((id) => [id, tags[0]] as const),
    );
    assert.deepEqual(
      assignedPairs.sort((x, y) => x[0] - y[0]),
      [
        [3, tagIdFor(emails[2]!)],
        [4, tagIdFor(emails[3]!)],
      ],
    );
    assert.deepEqual(removes, []);
    assert.ok(
      !assignedPairs.some(([id]) => id === 1 || id === 5),
      "already-tagged named seats and generics are not retagged",
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
    const result = await service.run({ now: new Date("2026-10-05T14:00:00.000Z") });
    assert.deepEqual(result, {
      assigned: 0,
      removed: 0,
      dualPodFlagged: 0,
      refused: 0,
    });
    assert.equal(ensured, 0, "drift-only: nothing ensured when nothing changes");
  });

  it("D223: flags dual POD-A+POD-B tags and does not write", async () => {
    const notes: string[] = [];
    const state = new StateStore(
      `/tmp/dw-pod-tags-dual-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const service = new PodTagService(
      loadConfig({ DRY_RUN: "false" } as NodeJS.ProcessEnv),
      {
        ensureTag: async () => {
          throw new Error("no writes expected");
        },
        assignTags: async () => {
          throw new Error("no writes expected");
        },
        removeTags: async () => {
          throw new Error("no writes expected");
        },
      } as never,
      state,
      {
        get: async () => ({
          campaigns: [
            { id: 50, name: "TechEvo A", status: "ACTIVE", client_id: 77 },
          ],
          accounts: [
            {
              id: 9,
              from_email: "ada@x.com",
              client_id: 77,
              tags: [{ tag_name: POD_TAG_A }, { tag_name: POD_TAG_B }],
            },
          ],
          clients: [{ id: 77, name: "TechEvo", logo: "TechEvo" }],
          fetchedAt: Date.now(),
        }),
      } as unknown as InventoryBook,
      async () => {},
      {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
          return undefined;
        },
      },
    );
    const result = await service.run({
      now: new Date("2026-10-05T13:16:00.000Z"),
    });
    assert.equal(result.assigned, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.dualPodFlagged, 1);
    assert.match(notes[0]!, /ada@x.com has POD-A and POD-B/);
    assert.doesNotMatch(notes[0]!, /—/);
  });

  it("D234: weekend cron idles; Josh-live may first-tag an untagged seat", async () => {
    const saturday = new Date("2026-10-04T02:24:00.000Z");
    const accounts = [
      {
        id: 3,
        from_email: "fresh@client.info",
        client_id: 9,
        campaign_ids: [50],
        tags: [],
      },
    ];
    const writes: string[] = [];
    const smartlead = {
      ensureTag: async (name: string) => {
        writes.push(`ensure:${name}`);
        return { id: name === POD_TAG_A ? 71 : 72, name };
      },
      assignTags: async (accountIds: number[]) => {
        writes.push(`assign:${accountIds.join(",")}`);
      },
      removeTags: async () => {
        writes.push("remove");
      },
    };

    const idleState = new StateStore(
      `/tmp/dw-pod-tags-wknd-idle-${process.pid}-${Date.now()}.json`,
    );
    await idleState.load();
    const idleService = new PodTagService(
      loadConfig({} as NodeJS.ProcessEnv),
      smartlead as never,
      idleState,
      bookWith(
        [{ id: 50, name: "Client campaign", status: "ACTIVE", client_id: 9 }],
        accounts,
      ),
      async () => {},
    );
    const idle = await idleService.run({ now: saturday });
    assert.equal(idle.skipped, true);
    assert.match(String(idle.reason), /weekend/);
    assert.equal(idle.assigned, 0);
    assert.deepEqual(writes, []);

    const liveState = new StateStore(
      `/tmp/dw-pod-tags-wknd-live-${process.pid}-${Date.now()}.json`,
    );
    await liveState.load();
    const liveService = new PodTagService(
      loadConfig({} as NodeJS.ProcessEnv),
      smartlead as never,
      liveState,
      bookWith(
        [{ id: 50, name: "Client campaign", status: "ACTIVE", client_id: 9 }],
        accounts,
      ),
      async () => {},
    );
    const live = await liveService.run({ now: saturday, joshLive: true });
    assert.equal(live.skipped, undefined);
    assert.ok(live.assigned >= 1);
    assert.ok(writes.some((row) => row.startsWith("assign:")));
  });
});
