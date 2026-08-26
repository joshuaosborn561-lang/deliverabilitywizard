import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POD_CONTROL_SHELL_NAME } from "./podControlShell.js";
import {
  CANARY_SHELL_SEED_EMAIL,
  canaryShellName,
  isAnyShellCampaign,
  isCanaryShellCampaign,
  liveCampaignIdFromCanaryShellName,
  shellLeadCount,
  shellLeadImportAccepted,
} from "./canaryShell.js";

describe("canary shell identity", () => {
  it("names a shell from the live campaign and reads the id back", () => {
    const name = canaryShellName(3479011, "Parlay Sports Offer");
    assert.equal(name.startsWith("Canary shell: #3479011"), true);
    assert.equal(liveCampaignIdFromCanaryShellName(name), 3479011);
    assert.equal(isCanaryShellCampaign({ id: 9, name }), true);
    assert.equal(isCanaryShellCampaign({ id: 1, name: "Parlay Sports Offer" }), false);
  });

  it("isAnyShellCampaign covers canary shells and the pod-control shell", () => {
    assert.equal(
      isAnyShellCampaign({ id: 2, name: "Canary shell: #4 Live A" }),
      true,
    );
    assert.equal(
      isAnyShellCampaign({ id: 1, name: POD_CONTROL_SHELL_NAME }),
      true,
    );
    assert.equal(isAnyShellCampaign({ id: 3, name: "Goliath L2" }), false);
    assert.equal(
      CANARY_SHELL_SEED_EMAIL,
      "canary.instrumentation@getcrosslaunchco.info",
    );
    assert.equal(CANARY_SHELL_SEED_EMAIL.includes("+"), false);
  });

  it("D118: import success reads upload_count / already_added, not only added_count", () => {
    assert.equal(shellLeadImportAccepted({ added_count: 1 }), true);
    assert.equal(shellLeadImportAccepted({ upload_count: 1, added_count: 0 }), true);
    assert.equal(
      shellLeadImportAccepted({ already_added_to_campaign: 1, added_count: 0 }),
      true,
    );
    assert.equal(shellLeadImportAccepted({ lead_ids: [99] }), true);
    assert.equal(
      shellLeadImportAccepted({ added_count: 0, skipped_count: 0 }),
      false,
    );
  });

  it("D118: lead count reads Smartlead's total / nested / leads shapes", () => {
    assert.equal(shellLeadCount({ total_leads: "1", data: [] }), 1);
    assert.equal(shellLeadCount({ total: 1, leads: [{ id: 1 }] }), 1);
    assert.equal(shellLeadCount({ data: { total_leads: 2, leads: [{}, {}] } }), 2);
    assert.equal(shellLeadCount({ total_leads: 0, data: [] }), 0);
  });
});
