import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAGE_OVERDUE_MS } from "../canon/constants.js";
import { countIntendedKind, countKind, formatStageOkLog, stageIsOverdue } from "./stageLog.js";

describe("stage ok log + overdue", () => {
  it("formats one line with counts", () => {
    assert.equal(
      formatStageOkLog("staff", { findings: 30, understaffed: 30, attach: 25 }),
      "[v2] staff ok findings=30 understaffed=30 attach=25",
    );
    assert.equal(countKind([{ kind: "understaffed" }, { kind: "esp_mix" }], "understaffed"), 1);
    assert.equal(countIntendedKind([{ kind: "attach" }], "attach"), 1);
  });

  it("a successful stamp is not overdue; a leftover last_error is", () => {
    assert.equal(STAGE_OVERDUE_MS, 20 * 60 * 1000);
    const now = Date.parse("2026-10-15T22:00:00.000Z");
    assert.equal(
      stageIsOverdue(
        {
          stage: "staff",
          lastOkAt: "2026-10-15T21:50:00.000Z",
          consecutiveFailures: 0,
        },
        now,
      ),
      false,
    );
    assert.equal(
      stageIsOverdue(
        {
          stage: "staff",
          lastError: "429",
          lastErrorAt: "2026-10-15T21:45:00.000Z",
          consecutiveFailures: 1,
        },
        now,
      ),
      true,
    );
    assert.equal(
      stageIsOverdue(
        {
          stage: "staff",
          lastOkAt: "2026-10-15T21:50:00.000Z",
          lastError: undefined,
          lastErrorAt: undefined,
          consecutiveFailures: 0,
        },
        now,
      ),
      false,
    );
  });
});
