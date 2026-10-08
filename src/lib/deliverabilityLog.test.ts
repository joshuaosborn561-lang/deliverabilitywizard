import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSlackLogKind,
  planDeliverabilityLogPost,
} from "./deliverabilityLog.js";

describe("D248 — deliverability log routing", () => {
  it("recognizes informational kinds and prefers the log channel", () => {
    assert.equal(isSlackLogKind("placement"), true);
    assert.equal(isSlackLogKind("ops_alert"), false);
    const toLog = planDeliverabilityLogPost({
      logChannel: "#wizard-log",
      humanChannel: "C0BJQUTV7A8",
      todayYmd: "2026-10-08",
      thread: null,
    });
    assert.deepEqual(toLog, { channel: "#wizard-log" });
  });

  it("falls back to one daily thread in #deliverability", () => {
    const first = planDeliverabilityLogPost({
      humanChannel: "C0BJQUTV7A8",
      todayYmd: "2026-10-08",
      thread: null,
    });
    assert.equal(first.channel, "C0BJQUTV7A8");
    assert.equal(first.openParent?.text, "*Wizard log — 2026-10-08*");

    const next = planDeliverabilityLogPost({
      humanChannel: "C0BJQUTV7A8",
      todayYmd: "2026-10-08",
      thread: { ymd: "2026-10-08", channel: "C0BJQUTV7A8", ts: "9.9" },
    });
    assert.deepEqual(next, { channel: "C0BJQUTV7A8", threadTs: "9.9" });
  });
});
