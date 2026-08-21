import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore, type HeldInboxRecord } from "../state/store.js";
import { RestBaselineRebuildService } from "./restBaselineRebuild.js";

function held(
  email: string,
  extra: Partial<HeldInboxRecord> = {},
): HeldInboxRecord {
  return {
    accountId: 1,
    email,
    heldAt: "2026-08-01T00:00:00.000Z",
    holdUntil: "2026-08-30",
    tagName: "HOLD-UNTIL-2026-08-30",
    ...extra,
  };
}

function account(
  email: string,
  id: number,
  tagNames: string[] = ["HOLD-UNTIL-2026-08-30"],
) {
  return {
    id,
    from_email: email,
    tags: tagNames.map((tag_name, index) => ({
      tag_id: 100 + index,
      tag_name,
    })),
  };
}

async function fixture(opts: {
  records?: HeldInboxRecord[];
  accounts?: ReturnType<typeof account>[];
  env?: Record<string, string>;
  dryRun?: boolean;
  alreadyRebuilt?: boolean;
  withSwap?: string;
}) {
  const state = new StateStore(
    `/tmp/rest-baseline-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  for (const record of opts.records ?? []) {
    state.markHeldInbox(record);
  }
  if (opts.withSwap) {
    state.markSwap({
      originalEmail: opts.withSwap,
      originalAccountId: 1,
      poolEmail: "spare@crosslaunchco.com",
      poolAccountId: 99,
      clientId: 9,
      clientName: "Client",
      campaignIds: [1],
      swappedAt: "2026-08-01T00:00:00.000Z",
      poolPlatform: "GOOGLE",
    });
  }
  if (opts.alreadyRebuilt) {
    state.markRestBaselineRebuilt("2026-08-21T00:00:00.000Z");
  }

  const removedTags: Array<[number[], number[]]> = [];
  const slack: string[] = [];
  const accounts = opts.accounts ?? [];
  const smartlead = {
    listAllEmailAccounts: async () => accounts,
    listTags: async () => [
      { id: 100, name: "HOLD-UNTIL-2026-08-30" },
      { id: 200, name: "WARMUP-GATE-EXEMPT" },
    ],
    removeTags: async (accountIds: number[], tagIds: number[]) => {
      removedTags.push([accountIds, [...tagIds]]);
    },
  } as unknown as SmartleadClient;

  const service = new RestBaselineRebuildService(
    loadConfig({
      ENABLE_REST_BASELINE_REBUILD: "true",
      DRY_RUN: "false",
      ...(opts.env ?? {}),
    }),
    smartlead,
    { send: async (text: string) => slack.push(text) } as unknown as SlackClient,
    state,
  );

  const result = await service.run({ dryRun: opts.dryRun });
  return { result, state, removedTags, slack };
}

describe("RestBaselineRebuildService", () => {
  it("keeps a mailbox that failed same-ESP (D32/D44)", async () => {
    const { result, state, removedTags } = await fixture({
      records: [
        held("weak@client.info", {
          scoredSameEsp: true,
          inboxRateSameEsp: 40,
          inboxRate: 90,
        }),
      ],
      accounts: [account("weak@client.info", 11)],
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(result.released, []);
    assert.equal(result.kept, 1);
    assert.ok(state.getHeldInbox("weak@client.info"));
    assert.equal(removedTags.length, 0);
    assert.ok(state.getRestBaselineRebuiltAt());
  });

  it("releases holds with no same-ESP score", async () => {
    const { result, state, removedTags } = await fixture({
      records: [held("none@client.info")],
      accounts: [account("none@client.info", 12)],
    });
    assert.deepEqual(result.released, ["none@client.info"]);
    assert.equal(state.getHeldInbox("none@client.info"), undefined);
    assert.equal(removedTags.length, 1);
    assert.deepEqual(removedTags[0][0], [12]);
    assert.deepEqual(removedTags[0][1], [100]);
  });

  it("releases blended-only and passing same-ESP holds", async () => {
    const { result, state } = await fixture({
      records: [
        held("blend@client.info", {
          scoredSameEsp: false,
          inboxRate: 40,
          inboxRateAll: 40,
        }),
        held("fine@client.info", {
          scoredSameEsp: true,
          inboxRateSameEsp: 92,
        }),
      ],
      accounts: [
        account("blend@client.info", 13),
        account("fine@client.info", 14),
      ],
    });
    assert.ok(result.released.includes("blend@client.info"));
    assert.ok(result.released.includes("fine@client.info"));
    assert.equal(state.getHeldInbox("blend@client.info"), undefined);
    assert.equal(state.getHeldInbox("fine@client.info"), undefined);
  });

  it("releases a HOLD tag with no state record", async () => {
    const { result, removedTags } = await fixture({
      records: [],
      accounts: [account("orphan@client.info", 15)],
    });
    assert.deepEqual(result.released, ["orphan@client.info"]);
    assert.equal(removedTags.length, 1);
  });

  it("clears a recovery swap reservation without a campaign yank", async () => {
    const { result, state } = await fixture({
      records: [held("moved@client.info")],
      accounts: [account("moved@client.info", 16)],
      withSwap: "moved@client.info",
    });
    assert.equal(result.swapsCleared, 1);
    assert.equal(state.getSwap("moved@client.info"), undefined);
    assert.equal(state.getHeldInbox("moved@client.info"), undefined);
  });

  it("does not strip WARMUP-GATE-EXEMPT", async () => {
    const { removedTags } = await fixture({
      records: [held("exempt@client.info")],
      accounts: [
        account("exempt@client.info", 17, [
          "HOLD-UNTIL-2026-08-30",
          "WARMUP-GATE-EXEMPT",
        ]),
      ],
    });
    assert.equal(removedTags.length, 1);
    assert.deepEqual(removedTags[0][1], [100]);
  });

  it("is one-shot after a successful rebuild", async () => {
    const { result, removedTags } = await fixture({
      alreadyRebuilt: true,
      records: [held("none@client.info")],
      accounts: [account("none@client.info", 18)],
    });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.released, []);
    assert.equal(removedTags.length, 0);
  });

  it("dry-run does not persist the rebuild stamp or clear holds", async () => {
    const { result, state, removedTags } = await fixture({
      dryRun: true,
      records: [held("none@client.info")],
      accounts: [account("none@client.info", 19)],
    });
    assert.deepEqual(result.released, ["none@client.info"]);
    assert.ok(state.getHeldInbox("none@client.info"));
    assert.equal(state.getRestBaselineRebuiltAt(), null);
    assert.equal(removedTags.length, 0);
  });

  it("skips when the flag is off", async () => {
    const { result } = await fixture({
      env: { ENABLE_REST_BASELINE_REBUILD: "false" },
      records: [held("none@client.info")],
    });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.released, []);
  });
});
