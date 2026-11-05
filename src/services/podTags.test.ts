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
      loadConfig({ ENABLE_NAMED_POD_REBALANCE: "false" } as NodeJS.ProcessEnv),
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

  it("D244: strips POD-A/POD-B from GABE-VM-RESERVED seats and never first-tags them", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-tags-reserved-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
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
    const accounts = [
      {
        id: 9,
        from_email: "gabe@getmesaco.info",
        client_id: 574020,
        campaign_ids: [4085158],
        tags: [{ tag_name: "GABE-VM-RESERVED" }, { tag_name: POD_TAG_A }],
      },
      {
        id: 10,
        from_email: "gabe@larkhavenco.info",
        client_id: 345263,
        campaign_ids: [],
        tags: [{ tag_name: "GABE-VM-RESERVED" }],
      },
    ];
    const service = new PodTagService(
      loadConfig({} as NodeJS.ProcessEnv),
      smartlead as never,
      state,
      bookWith(
        [
          {
            id: 4085158,
            name: "Gabe Calls | SalesGlider",
            status: "ACTIVE",
            client_id: 345263,
          },
        ],
        accounts,
      ),
      async () => {},
    );
    const result = await service.run({ now: new Date("2026-10-07T14:00:00.000Z") });
    assert.equal(result.assigned, 0);
    assert.equal(result.removed, 1);
    assert.deepEqual(assigns, []);
    assert.equal(removes.length, 1);
    assert.deepEqual(removes[0]![0], [9]);
    assert.ok(removes[0]![1]!.includes(71));
    assert.ok(removes[0]![1]!.includes(72));
  });
});

describe("PodTagService D316 — named seats within 15%", () => {
  const tagBody = (pod: "A" | "B") => [{ tag_name: pod === "A" ? POD_TAG_A : POD_TAG_B }];
  async function setup(opts: { aOnCampaign: boolean; dryRun?: boolean }) {
    const state = new StateStore(`/tmp/dw-d316-${process.pid}-${Date.now()}-${Math.random()}.json`);
    await state.load();
    const accounts: unknown[] = [];
    const mk = (id: number, pod: "A" | "B", onCampaign: boolean) => {
      const email = `n${id}@acme.test`;
      accounts.push({
        id,
        from_email: email,
        client_id: 9,
        type: id % 2 ? "GMAIL" : "OUTLOOK",
        campaign_ids: onCampaign ? [50] : [],
        tags: tagBody(pod),
      });
      if (!onCampaign) {
        state.markRestingInbox({ email, clientId: 9 } as never);
      }
    };
    for (let i = 1; i <= 20; i += 1) mk(i, "A", opts.aOnCampaign);
    for (let i = 21; i <= 24; i += 1) mk(i, "B", true);
    const assigns: Array<[number[], number[]]> = [];
    const removes: Array<[number[], number[]]> = [];
    const smartlead = {
      ensureTag: async (name: string) => ({ id: name === POD_TAG_A ? 71 : 72, name }),
      assignTags: async (ids: number[], tags: number[]) => void assigns.push([ids, tags]),
      removeTags: async (ids: number[], tags: number[]) => void removes.push([ids, tags]),
    };
    const config = loadConfig({ DRY_RUN: opts.dryRun ? "true" : "false" } as NodeJS.ProcessEnv);
    const service = new PodTagService(
      config,
      smartlead as never,
      state,
      bookWith([{ id: 50, name: "Acme", status: "ACTIVE", client_id: 9 }], accounts),
      async () => {},
    );
    return { service, assigns, removes };
  }
  const weekday = new Date("2026-10-05T14:00:00.000Z");

  it("retags idle POD-A seats to POD-B (remove old, add new) and caps the pass", async () => {
    const { service, assigns, removes } = await setup({ aOnCampaign: false });
    const result = await service.run({ now: weekday });
    assert.ok((result.rebalanced ?? 0) > 0 && (result.rebalanced ?? 0) <= 10);
    const moved = removes.flatMap(([ids]) => ids);
    assert.ok(moved.length > 0);
    assert.ok(moved.every((id) => id <= 20), "only POD-A seats move");
    assert.ok(removes.every(([, tags]) => tags[0] === 71), "old POD-A tag removed");
    assert.ok(assigns.some(([, tags]) => tags[0] === 72), "POD-B tag added");
  });

  it("never retags a seat that is on an ACTIVE campaign (no unlink from live sending)", async () => {
    const { service, removes } = await setup({ aOnCampaign: true });
    const result = await service.run({ now: weekday });
    assert.equal(result.rebalanced ?? 0, 0);
    assert.deepEqual(removes, []);
  });

  it("dry-run logs the plan and writes nothing", async () => {
    const { service, assigns, removes } = await setup({ aOnCampaign: false, dryRun: true });
    const result = await service.run({ now: weekday });
    assert.equal(result.rebalanced ?? 0, 0);
    assert.deepEqual([assigns, removes], [[], []]);
  });

  it("D324: does not retag an idle CAYDEN-SG seat and does not strip POD-A", async () => {
    const state = new StateStore(
      `/tmp/dw-d324-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const accounts = [
      ...[1, 2, 3, 4].map((id) => ({
        id,
        from_email: `a${id}@acme.test`,
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [50],
        tags: [{ tag_name: POD_TAG_A }],
      })),
      {
        id: 5,
        from_email: "b5@acme.test",
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [50],
        tags: [{ tag_name: POD_TAG_B }],
      },
      {
        id: 6,
        from_email: "cayden@salesglidermail.test",
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [],
        tags: [
          { tag_name: "CAYDEN-SG" },
          { tag_name: POD_TAG_A },
          { tag_name: "WARMUP-GATE-EXEMPT" },
        ],
      },
      {
        id: 7,
        from_email: "zidle@acme.test",
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [],
        tags: [{ tag_name: POD_TAG_A }],
      },
    ];
    state.markRestingInbox({
      email: "cayden@salesglidermail.test",
      clientId: 9,
    } as never);
    state.markRestingInbox({
      email: "zidle@acme.test",
      clientId: 9,
    } as never);
    const assigns: Array<[number[], number[]]> = [];
    const removes: Array<[number[], number[]]> = [];
    const smartlead = {
      ensureTag: async (name: string) => ({ id: name === POD_TAG_A ? 71 : 72, name }),
      assignTags: async (ids: number[], tags: number[]) => void assigns.push([ids, tags]),
      removeTags: async (ids: number[], tags: number[]) => void removes.push([ids, tags]),
    };
    const service = new PodTagService(
      loadConfig({ DRY_RUN: "false" } as NodeJS.ProcessEnv),
      smartlead as never,
      state,
      bookWith([{ id: 50, name: "Acme", status: "ACTIVE", client_id: 9 }], accounts),
      async () => {},
    );
    const result = await service.run({ now: weekday });
    const touched = [...assigns, ...removes].flatMap(([ids]) => ids);
    assert.equal(result.removed, 0, "POD-A is not stripped off CAYDEN-SG");
    assert.ok((result.rebalanced ?? 0) > 0, "an unlocked idle seat still moves");
    assert.ok(touched.includes(7));
    assert.ok(!touched.includes(6), "CAYDEN-SG POD-A must stay");
  });
});

describe("PodTagService D326 — even named split, off-week or idle", () => {
  const weekday = new Date("2026-10-05T14:00:00.000Z"); // A on, B off

  it("moves off-week named seats to even 21/59 even if they still have an ACTIVE leftover", async () => {
    const state = new StateStore(
      `/tmp/dw-d326-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const accounts = [
      ...Array.from({ length: 21 }, (_, i) => ({
        id: i + 1,
        from_email: `a${i + 1}@bpltg.test`,
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [50],
        tags: [{ tag_name: POD_TAG_A }],
      })),
      ...Array.from({ length: 59 }, (_, i) => ({
        id: 100 + i,
        from_email: `b${i + 1}@bpltg.test`,
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [50],
        tags: [{ tag_name: POD_TAG_B }],
      })),
    ];
    const assigns: Array<[number[], number[]]> = [];
    const removes: Array<[number[], number[]]> = [];
    const service = new PodTagService(
      loadConfig({ DRY_RUN: "false" } as NodeJS.ProcessEnv),
      {
        ensureTag: async (name: string) => ({
          id: name === POD_TAG_A ? 71 : 72,
          name,
        }),
        assignTags: async (ids: number[], tags: number[]) =>
          void assigns.push([ids, tags]),
        removeTags: async (ids: number[], tags: number[]) =>
          void removes.push([ids, tags]),
      } as never,
      state,
      bookWith([{ id: 50, name: "BPLTG", status: "ACTIVE", client_id: 9 }], accounts),
      async () => {},
    );
    const result = await service.run({ now: weekday });
    assert.equal(result.rebalanced, 19);
    const moved = removes.flatMap(([ids]) => ids);
    assert.ok(moved.every((id) => id >= 100), "only off-week POD-B seats move");
    assert.ok(assigns.some(([, tags]) => tags[0] === 71), "POD-A tag added");
  });

  it("keeps a 24h 5.7.233 / TERRL stop on its POD", async () => {
    const state = new StateStore(
      `/tmp/dw-d326-terl-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const accounts = [
      ...Array.from({ length: 2 }, (_, i) => ({
        id: i + 1,
        from_email: `a${i + 1}@acme.test`,
        client_id: 9,
        type: "GMAIL",
        campaign_ids: [],
        tags: [{ tag_name: POD_TAG_A }],
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 20 + i,
        from_email: `b${i + 1}@acme.test`,
        client_id: 9,
        type: "OUTLOOK",
        campaign_ids: [],
        tags: [{ tag_name: POD_TAG_B }],
      })),
    ];
    state.ensureBounceHold(
      accounts.filter((row) => row.id >= 20).map((row) => row.id),
      weekday,
    );
    const assigns: Array<[number[], number[]]> = [];
    const removes: Array<[number[], number[]]> = [];
    const service = new PodTagService(
      loadConfig({ DRY_RUN: "false" } as NodeJS.ProcessEnv),
      {
        ensureTag: async (name: string) => ({
          id: name === POD_TAG_A ? 71 : 72,
          name,
        }),
        assignTags: async (ids: number[], tags: number[]) =>
          void assigns.push([ids, tags]),
        removeTags: async (ids: number[], tags: number[]) =>
          void removes.push([ids, tags]),
      } as never,
      state,
      bookWith([{ id: 50, name: "Acme", status: "ACTIVE", client_id: 9 }], accounts),
      async () => {},
    );
    const result = await service.run({ now: weekday });
    assert.equal(result.rebalanced ?? 0, 0);
    assert.deepEqual(removes, []);
    assert.deepEqual(assigns, []);
  });
});

describe("PodTagService D326 fix — counts every named seat (Cayden 11/5)", () => {
  const weekday = new Date("2026-10-05T14:00:00.000Z"); // A on, B off
  const mk = (id: number, pod: "A" | "B", campaignIds: number[], extra: Array<{ tag_name: string; id?: number }> = [], type = "GMAIL") => ({
    id,
    from_email: `s${id}@acme.test`,
    client_id: 9,
    type,
    campaign_ids: campaignIds,
    tags: [{ tag_name: pod === "A" ? POD_TAG_A : POD_TAG_B }, ...extra],
  });
  async function run(accounts: unknown[]) {
    const state = new StateStore(`/tmp/dw-d326fix-${process.pid}-${Date.now()}-${Math.random()}.json`);
    await state.load();
    const writes: number[][] = [];
    const service = new PodTagService(
      loadConfig({ DRY_RUN: "false" } as NodeJS.ProcessEnv),
      {
        ensureTag: async (name: string) => ({ id: name === POD_TAG_A ? 71 : 72, name }),
        assignTags: async (ids: number[]) => void writes.push(ids),
        removeTags: async (ids: number[]) => void writes.push(ids),
      } as never,
      state,
      bookWith([{ id: 50, name: "Acme", status: "ACTIVE", client_id: 9 }], accounts),
      async () => {},
    );
    return { result: await service.run({ now: weekday }), writes };
  }

  it("idle named seats off the resting list count: real 40/40 is a no-op (old code moved 10 B→A)", async () => {
    const accounts = [
      ...Array.from({ length: 20 }, (_, i) => mk(1 + i, "A", [50])),
      // Idle POD-A seats NOT on the resting list — invisible to the old pod list.
      ...Array.from({ length: 20 }, (_, i) => mk(100 + i, "A", [])),
      ...Array.from({ length: 40 }, (_, i) => mk(200 + i, "B", [50])),
    ];
    const { result, writes } = await run(accounts);
    assert.equal(result.rebalanced ?? 0, 0);
    assert.deepEqual(writes, []);
  });

  it("excluded seats (GENERIC, CAYDEN-SG, GABE-VM-RESERVED, JEREMY-CIOTOLA, canary, HOLD-UNTIL) neither count nor move", async () => {
    const excluded = [
      mk(300, "B", [], [{ tag_name: "GENERIC", id: 510826 }]),
      mk(301, "B", [], [{ tag_name: "CAYDEN-SG" }]),
      mk(302, "B", [], [{ tag_name: "JEREMY-CIOTOLA", id: 533700 }]),
      mk(303, "B", [], [{ tag_name: "HOLD-UNTIL-2026-12-02", id: 547483 }]),
      mk(304, "B", [], [{ tag_name: "CANARY" }]),
      mk(305, "B", [], [{ tag_name: "GABE-VM-RESERVED" }]),
    ];
    const accounts = [
      ...Array.from({ length: 10 }, (_, i) => mk(1 + i, "A", [50])),
      ...Array.from({ length: 10 }, (_, i) => mk(200 + i, "B", [50])),
      ...excluded,
    ];
    const { result, writes } = await run(accounts);
    assert.equal(result.rebalanced ?? 0, 0, "10/10 named — reserved seats are not counted");
    // (D244 first-tag separately strips POD tags off GABE-VM-RESERVED; not D326.)
    const touched = writes.flat();
    assert.ok(excluded.filter((a) => a.id !== 305).every((a) => !touched.includes(a.id)));
  });

  it("still fixes a real lopsided split from the full count", async () => {
    const accounts = [
      ...Array.from({ length: 10 }, (_, i) => mk(1 + i, "A", [50])),
      ...Array.from({ length: 30 }, (_, i) => mk(200 + i, "B", [])),
    ];
    const { result } = await run(accounts);
    assert.equal(result.rebalanced, 10, "10/30 → 20/20");
  });
});
