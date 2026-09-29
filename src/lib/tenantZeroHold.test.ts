import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import {
  GETINTRODUCEDNOW_TENANT,
  GETINTRODUCEDNOW_TENANT_ZERO_IDS,
  NOWGETINTRODUCED_TENANT,
  NOWGETINTRODUCED_TENANT_ZERO_IDS,
  SALESGLIDERGET_TENANT,
  SALESGLIDERGET_TENANT_ZERO_IDS,
  SALESGLIDERLAB_TENANT,
  SALESGLIDERLAB_TENANT_ZERO_IDS,
  TENANT_ZERO_RESTORE_GRACE_MINUTES,
  nextTenantZeroRestoreAt,
  tenantLimitAlertKey,
  tenantZeroIdsForDomain,
  utcDayYmd,
} from "./tenantZeroHold.js";

describe("tenantZeroHold (D208)", () => {
  it("names Josh-held Outlook seats per tenant, not every sibling", () => {
    assert.deepEqual([...GETINTRODUCEDNOW_TENANT_ZERO_IDS], [
      21648785, 21648784, 21648783, 21648777, 21648693,
    ]);
    assert.deepEqual(
      [...tenantZeroIdsForDomain(GETINTRODUCEDNOW_TENANT)],
      [...GETINTRODUCEDNOW_TENANT_ZERO_IDS],
    );
    assert.deepEqual([...tenantZeroIdsForDomain(SALESGLIDERGET_TENANT)], [
      ...SALESGLIDERGET_TENANT_ZERO_IDS,
    ]);
    assert.deepEqual([...tenantZeroIdsForDomain(SALESGLIDERLAB_TENANT)], [
      ...SALESGLIDERLAB_TENANT_ZERO_IDS,
    ]);
    assert.deepEqual([...tenantZeroIdsForDomain(NOWGETINTRODUCED_TENANT)], [
      ...NOWGETINTRODUCED_TENANT_ZERO_IDS,
    ]);
    assert.deepEqual([...tenantZeroIdsForDomain("techevolutiontek.info")], []);
  });

  it("restores at 00:15 UTC the next cap-reset morning", () => {
    assert.equal(TENANT_ZERO_RESTORE_GRACE_MINUTES, 15);
    const midDay = new Date("2026-09-29T15:00:00.000Z");
    assert.equal(
      nextTenantZeroRestoreAt(midDay).toISOString(),
      "2026-09-30T00:15:00.000Z",
    );
    const justBefore = new Date("2026-09-30T00:14:59.000Z");
    assert.equal(
      nextTenantZeroRestoreAt(justBefore).toISOString(),
      "2026-09-30T00:15:00.000Z",
    );
    const justAfter = new Date("2026-09-30T00:15:00.000Z");
    assert.equal(
      nextTenantZeroRestoreAt(justAfter).toISOString(),
      "2026-10-01T00:15:00.000Z",
    );
  });

  it("keys the same-day D140 tenant-limit alert", () => {
    const now = new Date("2026-09-29T15:00:00.000Z");
    assert.equal(utcDayYmd(now), "2026-09-29");
    assert.equal(
      tenantLimitAlertKey("SalesGliderGet.info", utcDayYmd(now)),
      "tenant-limit:salesgliderget.info:2026-09-29",
    );
  });

  it("holds seeded ids until restoreAfter, then heals them off", async () => {
    const state = new StateStore(
      `/tmp/tenant-zero-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const midDay = new Date("2026-09-29T15:00:00.000Z");
    state.markAlert(tenantLimitAlertKey(SALESGLIDERLAB_TENANT, "2026-09-29"));
    state.healTenantZeroHold(midDay);
    assert.deepEqual(
      state.listTenantZeroIdsActive(),
      [...SALESGLIDERLAB_TENANT_ZERO_IDS].sort((a, b) => a - b),
    );
    assert.equal(state.isTenantZeroActive(16427893, midDay), true);
    assert.equal(state.isTenantZeroActive(1, midDay), false);
    const afterRestore = new Date("2026-09-30T00:15:00.000Z");
    state.healTenantZeroHold(afterRestore);
    assert.deepEqual(state.listTenantZeroIdsActive(), []);
    assert.equal(state.isTenantZeroActive(16427893, afterRestore), false);
  });
});
