import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOUNCE_HOLD_RESTORE_GRACE_MINUTES,
  accountOnBounceHold,
  bounceHoldWindowActive,
  hasTodayTenantCapSignal,
  mustNotRaiseHeldMpd,
  nextBounceHoldRestoreAt,
  tenantLimitAlertKey,
} from "./bounceHold.js";

describe("D212 bounce-hold skip", () => {
  const midAfternoon = new Date("2026-09-30T14:42:00.000Z");
  const afterRestore = new Date("2026-10-01T00:20:00.000Z");

  it("restore is 00:15 UTC (7:15pm CT) after the cap day", () => {
    assert.equal(BOUNCE_HOLD_RESTORE_GRACE_MINUTES, 15);
    assert.equal(
      nextBounceHoldRestoreAt(midAfternoon).toISOString(),
      "2026-10-01T00:15:00.000Z",
    );
    assert.equal(
      nextBounceHoldRestoreAt(new Date("2026-10-01T00:10:00.000Z")).toISOString(),
      "2026-10-01T00:15:00.000Z",
    );
    assert.equal(
      nextBounceHoldRestoreAt(afterRestore).toISOString(),
      "2026-10-02T00:15:00.000Z",
    );
  });

  it("window is open only while restoreAfter is in the future", () => {
    assert.equal(
      bounceHoldWindowActive("2026-10-01T00:15:00.000Z", midAfternoon),
      true,
    );
    assert.equal(
      bounceHoldWindowActive("2026-10-01T00:15:00.000Z", afterRestore),
      false,
    );
    assert.equal(bounceHoldWindowActive(null, midAfternoon), false);
  });

  it("keys the hold on Smartlead account id", () => {
    const store = {
      isBounceHoldWindowActive: () => true,
      isBounceHoldAccount: (id: number) => id === 21648785,
    };
    assert.equal(
      accountOnBounceHold(
        { id: 21648785, type: "OUTLOOK", message_per_day: 0 },
        store,
        midAfternoon,
      ),
      true,
    );
    assert.equal(
      accountOnBounceHold(
        { id: 99, type: "OUTLOOK", message_per_day: 15 },
        store,
        midAfternoon,
      ),
      false,
    );
  });

  it("Outlook already at 0 during an open window is held (Josh re-zero)", () => {
    const store = {
      isBounceHoldWindowActive: () => true,
      isBounceHoldAccount: () => false,
    };
    assert.equal(
      accountOnBounceHold(
        { id: 42, type: "OUTLOOK", message_per_day: 0 },
        store,
        midAfternoon,
      ),
      true,
    );
    assert.equal(
      accountOnBounceHold(
        { id: 42, type: "GMAIL", message_per_day: 0 },
        store,
        midAfternoon,
      ),
      false,
      "Gmail at 0 is not a tenant-cap hold",
    );
    assert.equal(
      accountOnBounceHold(
        { id: 42, type: "OUTLOOK", message_per_day: 0 },
        { isBounceHoldWindowActive: () => false, isBounceHoldAccount: () => false },
        midAfternoon,
      ),
      false,
      "unlisted zeros after the window are not held",
    );
  });

  it("D218: a listed id stays held after 00:15 UTC and must not be raised", () => {
    const store = {
      isBounceHoldWindowActive: () => false,
      isBounceHoldAccount: (id: number) => id === 21648785,
    };
    assert.equal(
      accountOnBounceHold(
        { id: 21648785, type: "OUTLOOK", message_per_day: 0 },
        store,
        afterRestore,
      ),
      true,
    );
    assert.equal(
      mustNotRaiseHeldMpd(
        { id: 21648785, type: "OUTLOOK", message_per_day: 0 },
        store,
        afterRestore,
      ),
      true,
    );
    assert.equal(
      accountOnBounceHold(
        { id: 99, type: "OUTLOOK", message_per_day: 0 },
        store,
        afterRestore,
      ),
      false,
      "unlisted Outlook at 0 after the window may be written",
    );
  });

  it("reads today's tenant-limit alert / tenant_rate_limit verdict", () => {
    assert.equal(
      tenantLimitAlertKey("CrossLaunchCoGet.info", "2026-09-30"),
      "tenant-limit:crosslaunchcoget.info:2026-09-30",
    );
    assert.equal(
      hasTodayTenantCapSignal(
        {
          alertedKeys: {
            "tenant-limit:crosslaunchcoget.info:2026-09-30":
              "2026-09-30T14:31:00.000Z",
          },
        },
        midAfternoon,
      ),
      true,
    );
    assert.equal(
      hasTodayTenantCapSignal(
        {
          bounceVerdicts: [
            {
              dominant: "tenant_rate_limit",
              at: "2026-09-30T14:31:00.000Z",
            },
          ],
        },
        midAfternoon,
      ),
      true,
    );
    assert.equal(
      hasTodayTenantCapSignal(
        {
          bounceVerdicts: [
            { dominant: "sender_blocked", at: "2026-09-30T14:31:00.000Z" },
          ],
        },
        midAfternoon,
      ),
      false,
    );
    assert.equal(
      hasTodayTenantCapSignal(
        {
          bounceVerdicts: [
            {
              dominant: "tenant_outbound_block",
              at: "2026-09-30T14:31:00.000Z",
            },
          ],
        },
        midAfternoon,
      ),
      false,
      "5.1.8 is not a tenant-cap signal (D213)",
    );
  });
});
