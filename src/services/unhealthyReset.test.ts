import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { UnhealthyResetService } from "./unhealthyReset.js";

describe("UnhealthyResetService", () => {
  it("wipes holds, HOLD-UNTIL tags, and control marks once", async () => {
    const state = new StateStore(
      `/tmp/unhealthy-reset-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markHeldInbox({
      email: "held@bcp.info",
      accountId: 1,
      holdUntil: "2099-01-01",
      tagName: "HOLD-UNTIL-2099-01-01",
      heldAt: "2026-08-01T00:00:00.000Z",
    });
    state.upsertMailboxControl({
      email: "held@bcp.info",
      podId: "client:1:B",
      lastTestId: "1",
      ranAt: "2026-08-01T00:00:00.000Z",
      placement: "SPAM",
      inboxRate: 10,
      scoredSameEsp: true,
      history: ["SPAM"],
      rollingFailCount: 3,
      tag: "kill",
    });

    const stripped: Array<[number[], number[]]> = [];
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "held@bcp.info",
          tags: [{ tag_id: 7, tag_name: "HOLD-UNTIL-2099-01-01" }],
        },
      ],
      listTags: async () => [{ id: 7, name: "HOLD-UNTIL-2099-01-01" }],
      removeTags: async (accountIds: number[], tagIds: number[]) => {
        stripped.push([accountIds, tagIds]);
      },
    } as unknown as SmartleadClient;

    const service = new UnhealthyResetService(
      loadConfig({ ENABLE_UNHEALTHY_RESET: "true", DRY_RUN: "false" }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const first = await service.run({ dryRun: false });
    assert.equal(first.skipped, false);
    assert.equal(first.heldCleared, 1);
    assert.deepEqual(stripped, [[[1], [7]]]);
    assert.equal(state.getHeldInbox("held@bcp.info"), undefined);
    assert.equal(state.listMailboxControls().length, 0);
    assert.ok(state.getUnhealthyResetAt());

    const second = await service.run({ dryRun: false });
    assert.equal(second.skipped, true);
    assert.equal(stripped.length, 1);
  });
});
