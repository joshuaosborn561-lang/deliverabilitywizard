import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  createLoopYielder,
  stringifyYielding,
  stringifyYieldingToFile,
} from "./stringifyYielding.js";

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

  it("D271: stringifyYieldingToFile matches JSON.stringify and yields", async () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) {
      wide[`k${i}`] = "x".repeat(400);
    }
    const filePath = `/tmp/dw-stringify-${process.pid}-${Date.now()}.json`;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const bytes = await stringifyYieldingToFile(wide, filePath, {
      yieldEvery: 4,
      flushBytes: 8_000,
    });
    clearInterval(timer);
    const body = await readFile(filePath, "utf8");
    await unlink(filePath).catch(() => undefined);
    assert.equal(body, JSON.stringify(wide));
    assert.ok(bytes > 0);
    assert.ok(ticks > 0, "file stringify must yield while flushing");
  });

  it("D272: time-slices even when yieldEvery would not fire", async () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 800; i += 1) {
      wide[`k${i}`] = "y".repeat(800);
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const body = await stringifyYielding(wide, {
      yieldEvery: 1_000_000,
      sliceMs: 4,
      flushBytes: 8_000,
    });
    clearInterval(timer);
    assert.equal(JSON.parse(body).k0.length, 800);
    assert.ok(
      ticks > 0,
      "time-sliced stringify must let setInterval fire without a count-based yield",
    );
  });

  it("D289: loop yielder time-slices even when the count cadence never fires", async () => {
    const yieldItem = createLoopYielder(1_000_000, 4);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    for (let i = 0; i < 80; i += 1) {
      const until = Date.now() + 5;
      while (Date.now() < until) {
        // burn ~5ms so a count-based every-1M never yields
      }
      await yieldItem();
    }
    clearInterval(timer);
    assert.ok(
      ticks > 0,
      "createLoopYielder must let setInterval fire without a count-based yield",
    );
  });
});
