import { describe, it } from "node:test";
import assert from "node:assert/strict";
import cron from "node-cron";
import { businessDate, parseSchedules } from "./sendVolume.js";

describe("parseSchedules", () => {
  it("splits the default 10:00 / 13:00 / 16:30 triple into valid expressions", () => {
    const schedules = parseSchedules("0 10 * * *|0 13 * * *|30 16 * * *");
    assert.deepEqual(schedules, ["0 10 * * *", "0 13 * * *", "30 16 * * *"]);
    for (const expression of schedules) {
      assert.equal(cron.validate(expression), true, expression);
    }
  });

  it("ships that triple as the config default (D156)", async () => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.cronSendVolume, "0 10 * * *|0 13 * * *|30 16 * * *");
  });

  it("does not split on the commas inside a cron field", () => {
    // A comma-separated parse would cut this into "0 9 * * 1" and "4".
    assert.deepEqual(parseSchedules("0 9 * * 1,4"), ["0 9 * * 1,4"]);
  });

  it("tolerates padding and empty segments", () => {
    assert.deepEqual(parseSchedules(" 0 12 * * * | | 30 16 * * * "), [
      "0 12 * * *",
      "30 16 * * *",
    ]);
  });
});

describe("businessDate", () => {
  it("uses the New York day, not the UTC day, late in the evening", () => {
    // 01:30 UTC on the 13th is still 21:30 on the 12th in New York.
    assert.equal(businessDate(new Date("2026-08-13T01:30:00Z")), "2026-08-12");
  });

  it("agrees with UTC during the working day", () => {
    assert.equal(businessDate(new Date("2026-08-12T15:00:00Z")), "2026-08-12");
  });
});
