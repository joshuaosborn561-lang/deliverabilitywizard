import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  copyIterableYielding,
  createLoopYielder,
  isCompactJsonValue,
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

  it("D299: matches JSON.stringify for key order, holes, dates, and escapes", async () => {
    const fat = { note: "q".repeat(5_000), n: 1 };
    const at = new Date("2026-10-23T10:45:00.000Z");
    const value = {
      b: 1,
      "10": 2,
      a: 3,
      "2": { z: true, skip: undefined, fn: () => 1 },
      "1": fat,
      when: at,
      items: [1, undefined, , at, "ok"],
      omit: { toJSON: () => undefined },
      keep: { toJSON: () => ({ inner: "x" }) },
      long: `${"a".repeat(8_191)}\uD83D\uDE00${"b".repeat(100)}\n"\\`,
    };
    const got = await stringifyYielding(value, { yieldEvery: 2, sliceMs: 4 });
    assert.equal(got, JSON.stringify(value));
  });

  it("D299: a wide map and a long string yield before a multi-second gap", async () => {
    const wide: Record<string, { email: string; n: number; pod: string }> = {};
    for (let i = 0; i < 4_000; i += 1) {
      wide[`user${i}@example.com`] = {
        email: `user${i}@example.com`,
        n: i,
        pod: i % 2 === 0 ? "A" : "B",
      };
    }
    wide.blob = {
      email: "z".repeat(200_000),
      n: -1,
      pod: "A",
    };
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    timer.unref?.();
    const body = await stringifyYielding(wide, { yieldEvery: 8, sliceMs: 8 });
    clearInterval(timer);
    assert.equal(body, JSON.stringify(wide));
    assert.ok(
      maxGap < 1_000,
      `stringify gap ${maxGap}ms must stay under the 1s watchdog log`,
    );
  });

  it("D300: objects and arrays are never compact native-stringify targets", () => {
    assert.equal(isCompactJsonValue({ a: 1, b: 2 }), false);
    assert.equal(isCompactJsonValue([1, 2, 3]), false);
    assert.equal(isCompactJsonValue("ok"), true);
    assert.equal(isCompactJsonValue(12), true);
    assert.equal(isCompactJsonValue(null), true);
  });

  it("D300: production-size state stays under the 1s watchdog log", async () => {
    const pool: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 6_000; i += 1) {
      pool[`user${i}@example.com`] = {
        email: `user${i}@example.com`,
        domain: `example${i % 40}.com`,
        platform: i % 2 === 0 ? "GOOGLE" : "MICROSOFT",
        firstName: "Seat",
        lastName: `N${i}`,
        status: "warm",
        assignedClientId: i % 12,
        assignedClientName: `Client ${i % 12}`,
        assignedAt: "2026-10-01T00:00:00.000Z",
        warmedAt: "2026-09-01T00:00:00.000Z",
        pod: i % 2 === 0 ? "A" : "B",
      };
    }
    const scores: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 400; i += 1) {
      scores[String(4_000_000 + i)] = {
        campaignId: 4_000_000 + i,
        campaignName: `Score ${i}`,
        testId: `t-${i}`,
        source: "canary-copy",
        inboxPercent: i % 100,
        at: "2026-10-19T00:00:00.000Z",
        raw: "x".repeat(3_000),
      };
    }
    const state = {
      version: 1,
      lastScanAt: "2026-10-23T08:14:00.000Z",
      poolMailboxes: pool,
      isolation: { placementScores: scores, copyCanaries: {}, actions: {} },
      campaignChecks: Object.fromEntries(
        Array.from({ length: 800 }, (_, i) => [
          String(i),
          { id: i, at: "2026-10-23T00:00:00.000Z", findings: ["ok"] },
        ]),
      ),
      note: "z".repeat(80_000),
    };
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    timer.unref?.();
    const filePath = `/tmp/dw-stringify-d300-${process.pid}.json`;
    const bytes = await stringifyYieldingToFile(state, filePath, {
      yieldEvery: 8,
      sliceMs: 8,
    });
    clearInterval(timer);
    const body = await readFile(filePath, "utf8");
    await unlink(filePath).catch(() => undefined);
    assert.equal(body, JSON.stringify(state));
    assert.ok(bytes > 1_000_000, `expected a fat dump, got ${bytes} bytes`);
    assert.ok(
      maxGap < 1_000,
      `production-size stringify gap ${maxGap}ms must stay under 1s`,
    );
  });

  it("D300: copying a large gone-email set yields before a 1s gap", async () => {
    const gone = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      gone.add(`ghost${i}@retired.example`);
    }
    let last = Date.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    timer.unref?.();
    const copied = await copyIterableYielding(gone);
    clearInterval(timer);
    assert.equal(copied.length, 20_000);
    assert.ok(
      maxGap < 1_000,
      `gone-set copy gap ${maxGap}ms must stay under 1s`,
    );
  });
});
