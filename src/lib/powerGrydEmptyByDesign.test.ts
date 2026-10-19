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

  it("D283: Onboarding-freed seats cannot flip back onto PowerGRYD; free-pool may", () => {
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
        assignedReason: "powergryd_dedicated",
      }),
      true,
      "freed SL-null leftover PowerGRYD owner must not restaff onto 592842",
    );
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 900,
          from_email: "spare@crosslaunchco.com",
          from_name: "Harmony Norris",
          signature: "",
          client_id: null,
        } as SmartleadAccountWithCampaigns,
        email: "spare@crosslaunchco.com",
        targetClientId: 592842,
        emptyByDesign: false,
        mailboxClientId: null,
        assignedClientId: null,
      }),
      false,
      "PowerGRYD may take a free-pool generic (D285)",
    );
  });

  it("D292: leftover foreign signature on a free ledger seat does not block PowerGRYD", () => {
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 901,
          from_email: "cover@crosslaunchco.com",
          from_name: "Cover Seat",
          signature: "Cover Seat\nTechEvolution",
          client_id: null,
        } as SmartleadAccountWithCampaigns,
        email: "cover@crosslaunchco.com",
        targetClientId: 592842,
        emptyByDesign: true,
        mailboxClientId: null,
        assignedClientId: null,
        powerGrydBrand: "PowerGRYD",
        allBrands: ["PowerGRYD", "TechEvolution", "Insight", "Emcor"],
      }),
      false,
      "empty-by-design must not refuse rotating a free warm generic whose leftover sig will be rewritten",
    );
    assert.equal(
      genericBlockedOnPowerGrydStaffing({
        account: {
          id: 902,
          from_email: "ada@crosslaunchco.com",
          from_name: "Ada Pool",
          signature: "Ada Pool\nTechEvolution",
          client_id: 900001,
        } as SmartleadAccountWithCampaigns,
        email: "ada@crosslaunchco.com",
        targetClientId: 592842,
        emptyByDesign: true,
        mailboxClientId: 900001,
        assignedClientId: null,
        isMarkerClientId: (id) => id === 900001,
        powerGrydBrand: "PowerGRYD",
        allBrands: ["PowerGRYD", "TechEvolution", "Insight", "Emcor"],
      }),
      false,
      "leftover marker Generic/POC client_id is not a live named owner",
    );
  });
});
