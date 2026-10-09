import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findReassignablePoolMailboxYielding,
  isReassignablePoolMailbox,
} from "./poolPick.js";

describe("poolPick (D252)", () => {
  it("skips rejected emails and yields while scanning", async () => {
    const mailboxes = Array.from({ length: 40 }, (_, i) => ({
      email: `g${i}@crosslaunchco.com`,
      platform: i % 2 === 0 ? ("GOOGLE" as const) : ("MICROSOFT" as const),
      status: "available",
    }));
    const rejected = new Set<string>(["g0@crosslaunchco.com"]);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const found = await findReassignablePoolMailboxYielding(
      mailboxes,
      ["GOOGLE"],
      (email) => email === "g8@crosslaunchco.com",
      { rejected, yieldEvery: 2 },
    );
    clearInterval(timer);
    assert.equal(found?.email, "g8@crosslaunchco.com");
    assert.equal(rejected.has("g2@crosslaunchco.com"), true);
    assert.equal(rejected.has("g0@crosslaunchco.com"), true);
    assert.ok(ticks > 0, "event loop must breathe during a pool scan");
  });

  it("does not treat warming or canary rows as supply", () => {
    assert.equal(
      isReassignablePoolMailbox(
        { email: "w@crosslaunchco.com", platform: "GOOGLE", status: "warming" },
        "GOOGLE",
      ),
      false,
    );
    assert.equal(
      isReassignablePoolMailbox(
        {
          email: "c@crosslaunchco.com",
          platform: "GOOGLE",
          status: "available",
          copyCanary: true,
        },
        "GOOGLE",
      ),
      false,
    );
  });
});
