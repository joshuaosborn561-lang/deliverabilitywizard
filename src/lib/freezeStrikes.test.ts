import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import {
  FREEZE_QUARANTINE_MS,
  FREEZE_STRIKE_LIMIT,
  clearFreezeStrike,
  freezeStrikesPath,
  noteFreezeStrike,
  quarantinedStageNames,
  readFreezeStrikes,
} from "./freezeStrikes.js";

describe("D299 freeze strikes", () => {
  const now = Date.parse("2026-10-23T15:00:00.000Z");

  it("quarantines on the third strike and renews on the next", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dw-strikes-"));
    const stateFile = path.join(dir, "state.json");
    try {
      noteFreezeStrike(stateFile, "campaign-health", now);
      noteFreezeStrike(stateFile, "campaign-health", now + 1_000);
      assert.deepEqual(quarantinedStageNames(stateFile, now + 2_000), []);
      const third = noteFreezeStrike(stateFile, "campaign-health", now + 2_000);
      assert.equal(third.stages["campaign-health"]?.count, FREEZE_STRIKE_LIMIT);
      assert.deepEqual(quarantinedStageNames(stateFile, now + 2_000), [
        "campaign-health",
      ]);
      const until = Date.parse(
        third.stages["campaign-health"]?.quarantineUntil ?? "",
      );
      assert.equal(until, now + 2_000 + FREEZE_QUARANTINE_MS);
      assert.deepEqual(
        quarantinedStageNames(stateFile, until + 1),
        [],
        "an expired window is a retry, not a permanent skip",
      );
      const renewed = noteFreezeStrike(stateFile, "campaign-health", until + 1);
      const next = Date.parse(
        renewed.stages["campaign-health"]?.quarantineUntil ?? "",
      );
      assert.equal(next, until + 1 + FREEZE_QUARANTINE_MS);
      assert.equal(renewed.stages["campaign-health"]?.count, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clear removes the stage and does not create a file when there is none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dw-strikes-"));
    const stateFile = path.join(dir, "state.json");
    try {
      clearFreezeStrike(stateFile, "campaign-health");
      assert.equal(existsSync(freezeStrikesPath(stateFile)), false);
      noteFreezeStrike(stateFile, "campaign-health", now);
      noteFreezeStrike(stateFile, "pod-cover", now);
      clearFreezeStrike(stateFile, "campaign-health");
      const book = readFreezeStrikes(stateFile);
      assert.equal(book.stages["campaign-health"], undefined);
      assert.equal(book.stages["pod-cover"]?.count, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("StateStore clears the strike when the stage records ok", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dw-strikes-"));
    const stateFile = path.join(dir, "state.json");
    try {
      const state = new StateStore(stateFile);
      await state.load();
      state.noteFreezeStrike("campaign-health", now);
      state.noteFreezeStrike("campaign-health", now + 1);
      state.noteFreezeStrike("campaign-health", now + 2);
      assert.ok(state.quarantinedHealthStages(now + 3).has("campaign-health"));
      state.recordStageOk("campaign-health", 40);
      assert.equal(state.quarantinedHealthStages(now + 4).size, 0);
      assert.equal(readFreezeStrikes(stateFile).stages["campaign-health"], undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
