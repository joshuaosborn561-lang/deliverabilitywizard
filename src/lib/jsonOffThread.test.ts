import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  parseFileOffThread,
  parseTextOffThread,
  stringifyOffThread,
} from "./jsonOffThread.js";

describe("D257 off-thread JSON", () => {
  it("stringifies and parses without pinning the event loop", async () => {
    const value: Record<string, { n: number; nest: { k: string } }> = {};
    for (let i = 0; i < 400; i += 1) {
      value[`k${i}`] = { n: i, nest: { k: `v${i}` } };
    }

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    timer.unref?.();

    const body = await stringifyOffThread(value);
    clearInterval(timer);
    assert.equal(body.includes("\n  "), false, "compact JSON must not indent");
    assert.ok(ticks > 0, "setInterval must fire while the worker stringifies");

    const parsed = await parseTextOffThread<typeof value>(body);
    assert.equal(parsed.k0?.n, 0);
    assert.equal(parsed.k399?.n, 399);
  });

  it("parses a file off-thread", async () => {
    const filePath = `/tmp/dw-json-off-${process.pid}-${Date.now()}.json`;
    await writeFile(filePath, JSON.stringify({ ok: true, n: 7 }), "utf8");
    const parsed = await parseFileOffThread<{ ok: boolean; n: number }>(filePath);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.n, 7);
  });
});
