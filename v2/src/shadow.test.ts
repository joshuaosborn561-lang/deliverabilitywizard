import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { WriteGate } from "./shadow.js";
import { MemoryStore } from "./store.js";

describe("hard SHADOW write barrier", () => {
  it("logs attach/detach/isolate/test/slack/inboxkit and never runs the write", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    let ran = 0;
    const kinds = [
      "attach",
      "detach",
      "isolate",
      "test_create",
      "inboxkit_delete",
      "slack",
      "spend",
    ] as const;
    for (const kind of kinds) {
      const result = await gate.intend({
        kind,
        campaignId: 1,
        payload: { hello: kind },
        run: async () => {
          ran += 1;
          return "wrote";
        },
      });
      assert.equal(result.executed, false);
      assert.equal(result.shadowed, true);
      assert.equal(result.result, undefined);
    }
    assert.equal(ran, 0, "zero Smartlead/InboxKit/Slack writes");
    const logged = await store.listIntended();
    assert.equal(logged.length, kinds.length);
    assert.ok(logged.every((a) => a.shadowed && !a.executed));
  });

  it("D276: slack intends are quiet-hours blocked even if a write were allowed", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const saturday = new Date("2026-10-17T15:00:00.000Z");
    const result = await gate.intend({
      kind: "slack",
      payload: { text: "hi" },
      now: saturday,
      run: async () => "posted",
    });
    assert.equal(result.executed, false);
    assert.match(String(result.action.blockedReason ?? ""), /quiet_hours/);
  });
});
