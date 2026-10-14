import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { slackAllowed, slackKindForIsolationAction } from "./slackAllow.js";
import {
  DLV_ACTION_IDS,
  handleDeliverabilitySlackAction,
  isDlvActionId,
} from "./deliverabilitySlack.js";
import { dropPendingAllowGenerics } from "../state/isolationState.js";
import { StateStore } from "../state/store.js";
import { buildIsolationAction } from "./isolationActions.js";
import { IsolationExecuteService } from "../services/isolationExecute.js";
import type { InventoryBook } from "../services/inventory.js";

function stateFile(): string {
  return `/tmp/allow-gone-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function emptyBook(): InventoryBook {
  return {
    get: async () => ({
      campaigns: [],
      accounts: [],
      clients: [],
      fetchedAt: Date.now(),
    }),
  } as InventoryBook;
}

describe("D268 — Allow-generics path is gone", () => {
  it("Slack will not post or allow a generic_backfill card", () => {
    assert.equal(slackAllowed("generic_backfill" as never), false);
    assert.equal(slackKindForIsolationAction("generic_backfill"), null);
  });

  it("Deliverability one-taps have no generics button", () => {
    assert.equal(isDlvActionId("dlv_generics_not_now"), false);
    assert.equal(
      (DLV_ACTION_IDS as readonly string[]).includes("dlv_generics_not_now"),
      false,
    );
  });

  it("source tree has no Allow-generics card, handler, or auto-allow loop", async () => {
    const files = [
      new URL("../clients/slack.ts", import.meta.url),
      new URL("../services/min40TopUp.ts", import.meta.url),
      new URL("../services/campaignCheck.ts", import.meta.url),
      new URL("../services/isolationExecute.ts", import.meta.url),
      new URL("./deliverabilitySlack.ts", import.meta.url),
      new URL("./slackAllow.ts", import.meta.url),
      new URL("../index.ts", import.meta.url),
      new URL("../config.ts", import.meta.url),
    ];
    for (const url of files) {
      const src = await readFile(url, "utf8");
      assert.doesNotMatch(
        src,
        /Allow generics/,
        `${url.pathname} still has an Allow generics card`,
      );
      assert.doesNotMatch(
        src,
        /notifyGenericBackfillBatch|requestGenericBackfillAsks|clientAutoAllowsGenerics|DEFAULT_AUTO_ALLOW_GENERIC_CLIENT_IDS|DLV_GENERICS_NOT_NOW|autoAllowGenericClientIds/,
        `${url.pathname} still has an Allow-generics path`,
      );
    }
  });

  it("drops leftover pending Allow-generics isolation actions on load", async () => {
    const kept = dropPendingAllowGenerics({
      live: {
        id: "retire-1",
        kind: "retire_domain",
        status: "pending",
        title: "Retire burned.info",
        proof: "proof",
        detail: { domain: "burned.info" },
        allowed: "owner_or_operator",
        requestedAt: "2026-10-14T00:00:00Z",
      },
      stale: {
        id: "generic_backfill-1",
        kind: "generic_backfill",
        status: "pending",
        title: "Allow generics on 2 campaigns",
        proof: "floor",
        detail: { campaignIds: [1, 2] },
        allowed: "owner",
        requestedAt: "2026-10-14T00:00:00Z",
      },
    });
    assert.deepEqual(Object.keys(kept), ["live"]);

    const path = stateFile();
    const store = new StateStore(path);
    await store.load();
    store.upsertIsolationAction(
      buildIsolationAction({
        kind: "generic_backfill",
        title: "Allow generics on 2 campaigns",
        proof: "floor",
        detail: { campaignIds: [1, 2] },
      }),
    );
    await store.save();
    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(
      reloaded.listIsolationActions().some((row) => row.kind === "generic_backfill"),
      false,
    );
  });

  it("leftover Allow tap does not attach or record approval", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const action = buildIsolationAction({
      kind: "generic_backfill",
      title: "Allow generics on 2 campaigns",
      proof: "floor",
      detail: { campaignIds: [11, 12] },
    });
    state.upsertIsolationAction(action);
    const svc = new IsolationExecuteService(
      loadConfig({} as NodeJS.ProcessEnv),
      {} as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
      emptyBook(),
    );
    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /retired \(D268\)/);
    assert.equal(state.getGenericBackfillApproval(11), undefined);
    assert.equal(state.getGenericBackfillApproval(12), undefined);
  });

  it("leftover dlv_generics_not_now button is not a Deliverability one-tap", async () => {
    const state = new StateStore(stateFile());
    await state.load();
    const result = await handleDeliverabilitySlackAction({
      actionId: "dlv_generics_not_now",
      value: JSON.stringify({ campaignId: 2, isolationActionId: "generic_backfill-1" }),
      actor: { name: "Josh", role: "owner" },
      state,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /not a Deliverability one-tap/);
  });
});
