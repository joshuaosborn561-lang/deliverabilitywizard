import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stringifyYielding } from "./stringifyYielding.js";

describe("stringifyYielding (D249)", () => {
  it("matches JSON.stringify for nested objects and skips undefined", async () => {
    const value = {
      a: 1,
      b: { c: true, d: "x" },
      e: [1, null, "z"],
      skip: undefined,
    };
    const expected = JSON.stringify(value);
    const got = await stringifyYielding(value, { yieldEvery: 1 });
    assert.equal(got, expected);
    assert.equal(got.includes("\n  "), false, "compact JSON must not indent");
  });

  it("does not pin the event loop while walking a large object", async () => {
    const big: Record<string, { n: number; nest: { k: string } }> = {};
    for (let i = 0; i < 200; i += 1) {
      big[`k${i}`] = { n: i, nest: { k: `v${i}` } };
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const body = await stringifyYielding(big, { yieldEvery: 4 });
    clearInterval(timer);
    assert.equal(JSON.parse(body).k0.n, 0);
    assert.equal(JSON.parse(body).k199.n, 199);
    assert.ok(
      ticks > 0,
      "setInterval must have fired while stringifyYielding walked the graph",
    );
  });

  it("D252: joining a wide object does not pin the event loop", async () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) {
      wide[`k${i}`] = "x".repeat(200);
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const body = await stringifyYielding(wide, { yieldEvery: 8 });
    clearInterval(timer);
    assert.equal(JSON.parse(body).k0.length, 200);
    assert.ok(ticks > 0, "joinYielding must yield between chunks");
  });
});
