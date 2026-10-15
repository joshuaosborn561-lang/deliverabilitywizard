import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeDelayLogLine,
  formatStallAttribution,
  runWithStallScope,
  runWithStallScopeAsync,
  seedStallSnapshot,
  startEventLoopAttribution,
} from "./eventLoopAttribution.js";

describe("D271 event-loop stall attribution", () => {
  it("names the in-flight stage, named op, async type, and sampled stack", () => {
    seedStallSnapshot({
      op: "json.parseFile",
      asyncType: "PROMISE",
      stack: "at parseSlimEmailAccountsFromFile (accountMembership.ts:63)",
    });
    const line = freezeDelayLogLine(18234, [
      { name: "health", stage: "inventory", since: 1, maxMs: 1 },
      { name: "monitor", stage: "campaign-audit", since: 1, maxMs: 1 },
    ]);
    assert.match(line, /\[watchdog\] event-loop delay 18234ms/);
    assert.match(line, /stage=health:inventory,monitor:campaign-audit/);
    assert.match(line, /op=json.parseFile/);
    assert.match(line, /async=PROMISE/);
    assert.match(line, /stack=at parseSlimEmailAccountsFromFile/);
  });

  it("runWithStallScope stamps the op the watchdog will read after a stall", async () => {
    const attr = startEventLoopAttribution();
    try {
      const during = runWithStallScope("json.stringify:state", () =>
        formatStallAttribution([
          { name: "health", stage: "client-rest", since: 10, maxMs: 1 },
        ]),
      );
      assert.match(during, /stage=health:client-rest/);
      assert.match(during, /op=json.stringify:state/);
      await runWithStallScopeAsync("json.parseFile", async () => undefined);
      const after = formatStallAttribution([
        { name: "health", stage: "inventory", since: 10, maxMs: 1 },
      ]);
      assert.match(after, /stage=health:inventory/);
      assert.match(after, /op=json.parseFile/);
    } finally {
      attr.stop();
    }
  });

  it("idle locks render as stage=none", () => {
    seedStallSnapshot({ op: "unknown", asyncType: null, stack: null });
    const text = formatStallAttribution([
      { name: "health", stage: null, since: null, maxMs: 1 },
    ]);
    assert.match(text, /stage=none/);
  });
});
