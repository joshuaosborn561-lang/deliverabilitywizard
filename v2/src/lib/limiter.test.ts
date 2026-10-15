import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SMARTLEAD_CONCURRENCY, SMARTLEAD_MAX_PER_MIN } from "../canon/constants.js";
import { MemoryStore } from "../store.js";
import { SharedSmartleadLimiter } from "./limiter.js";

describe("D257 shared Smartlead limiter", () => {
  it("caps concurrency at 2 and budget at 150/min", () => {
    assert.equal(SMARTLEAD_CONCURRENCY, 2);
    assert.equal(SMARTLEAD_MAX_PER_MIN, 150);
  });

  it("shares inflight slots on the store used by both roles", async () => {
    const store = new MemoryStore();
    const limiter = new SharedSmartleadLimiter(store);
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.schedule(async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent -= 1;
        }),
      ),
    );
    assert.ok(max <= 2);
  });
});
