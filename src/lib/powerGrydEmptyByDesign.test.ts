import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import {
  genericBlockedOnPowerGrydStaffing,
  isPowerGrydEmptyByDesign,
  staffableNamedPowerGrydCount,
} from "./powerGrydEmptyByDesign.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";

function warmingPgNamed(i: number): SmartleadAccountWithCampaigns {
  return {
    id: 200 + i,
    from_email: `pg${i}@powergryd.com`,
    client_id: 592842,
    type: "GMAIL",
    is_smtp_success: true,
    is_imap_success: true,
    created_at: "2026-10-10T00:00:00.000Z",
    campaign_ids: [],
  } as SmartleadAccountWithCampaigns;
}

describe("D258 PowerGRYD empty-by-design", () => {
  it("is on when branded named seats are still warming", async () => {
    const state = new StateStore(
      `/tmp/pg-empty-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({ DRY_RUN: "true" });
    const accounts = [warmingPgNamed(0), warmingPgNamed(1)];
    assert.equal(
      staffableNamedPowerGrydCount({ accounts, config, state }),
      0,
    );
    assert.equal(
      isPowerGrydEmptyByDesign({ accounts, config, state }),
      true,
    );
  });

  it("blocks a TechEvo/Insight-signed generic onto PowerGRYD", () => {
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 1,
          from_email: "andreaadams@myoutreachdesk.info",
          from_name: "Andrea Adams",
          signature: "Andrea Adams\nTechEvolution",
          client_id: 521881,
        } as SmartleadAccountWithCampaigns,
        email: "andreaadams@myoutreachdesk.info",
        targetClientId: 592842,
        emptyByDesign: true,
        mailboxClientId: 521881,
        assignedClientId: 592842,
        powerGrydBrand: "PowerGRYD",
        allBrands: ["PowerGRYD", "TechEvolution", "Insight"],
      }),
      true,
    );
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 2,
          from_email: "brianbrown@usemeetconnect.info",
          from_name: "Brian Brown",
          signature: "Brian Brown\nInsight",
          client_id: 582890,
        } as SmartleadAccountWithCampaigns,
        email: "brianbrown@usemeetconnect.info",
        targetClientId: 592842,
        emptyByDesign: true,
        mailboxClientId: 582890,
        assignedClientId: 592842,
        powerGrydBrand: "PowerGRYD",
        allBrands: ["PowerGRYD", "TechEvolution", "Insight"],
      }),
      true,
    );
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 3,
          from_email: "andreaadams@myoutreachdesk.info",
          client_id: 521881,
        } as SmartleadAccountWithCampaigns,
        email: "andreaadams@myoutreachdesk.info",
        targetClientId: 521881,
        emptyByDesign: true,
        mailboxClientId: 521881,
        assignedClientId: 592842,
      }),
      false,
      "the block is PowerGRYD-target only — TechEvo may keep its own seat",
    );
  });

  it("D283: never staff any generic onto PowerGRYD", () => {
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 21592200,
          from_email: "christinaevans@getoutreachdesk.info",
          from_name: "Christina Evans",
          signature: "Christina Evans",
          client_id: null,
        } as SmartleadAccountWithCampaigns,
        email: "christinaevans@getoutreachdesk.info",
        targetClientId: 592842,
        emptyByDesign: false,
        mailboxClientId: null,
        assignedClientId: 592842,
      }),
      true,
    );
  });
});
