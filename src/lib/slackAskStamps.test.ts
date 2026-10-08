import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendSlackStamp,
  latestSlackStamp,
  slackStampsFromDetail,
} from "./slackAskStamps.js";

describe("D248 — persist every posted ask ts", () => {
  it("reads the legacy slackChannel + slackTs and the slackMessages list", () => {
    const stamps = slackStampsFromDetail({
      slackChannel: "C1",
      slackTs: "1.1",
      slackMessages: [
        { channel: "C1", ts: "1.1" },
        { channel: "C1", ts: "2.2" },
      ],
    });
    assert.deepEqual(stamps, [
      { channel: "C1", ts: "1.1" },
      { channel: "C1", ts: "2.2" },
    ]);
  });

  it("appends a new stamp without dropping older copies", () => {
    const first = appendSlackStamp({}, { channel: "C1", ts: "1.1" });
    const second = appendSlackStamp(first, { channel: "C1", ts: "2.2" });
    assert.deepEqual(slackStampsFromDetail(second), [
      { channel: "C1", ts: "1.1" },
      { channel: "C1", ts: "2.2" },
    ]);
    assert.equal(latestSlackStamp(second)?.ts, "2.2");
    const again = appendSlackStamp(second, { channel: "C1", ts: "2.2" });
    assert.equal(slackStampsFromDetail(again).length, 2);
  });
});
