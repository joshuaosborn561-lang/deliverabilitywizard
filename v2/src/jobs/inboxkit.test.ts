import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLapsedSeat } from "../clients/inboxkit.js";
import { loadConfig } from "../config.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";
import { runInboxkitSweep } from "./inboxkit.js";

describe("job 6 InboxKit sweep", () => {
  it("D245: scheduled cancel on or before today is lapsed; future is not", () => {
    assert.equal(
      isLapsedSeat(
        { email: "a@x.info", status: "active", scheduledForCancellation: true, cancelDate: "2020-01-01" },
        "2026-10-15",
      ),
      true,
    );
    assert.equal(
      isLapsedSeat(
        { email: "a@x.info", status: "active", scheduledForCancellation: true, cancelDate: "2099-01-01" },
        "2026-10-15",
      ),
      false,
    );
    assert.equal(
      isLapsedSeat({ email: "a@x.info", status: "active", renewalDate: "2020-01-01" }, "2026-10-15"),
      false,
    );
  });

  it("intends Smartlead + InboxKit deletes and a Slack one-liner, executes none", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runInboxkitSweep({
      seats: [{ email: "gone@x.info", status: "lapsed" }],
      accounts: [],
      gate,
    });
    assert.equal(result.deleted, 1);
    assert.ok(result.intended.some((a) => a.kind === "inboxkit_delete" && a.shadowed));
    assert.ok(result.intended.some((a) => a.kind === "smartlead_delete" && a.shadowed));
    assert.ok(result.intended.some((a) => a.kind === "slack"));
  });
});
