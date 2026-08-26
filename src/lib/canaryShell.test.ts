import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POD_CONTROL_SHELL_NAME } from "./podControlShell.js";
import {
  CANARY_SHELL_SEED_EMAIL,
  canaryShellName,
  isAnyShellCampaign,
  isCanaryShellCampaign,
  liveCampaignIdFromCanaryShellName,
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
      "canary.shell.seed@getcrosslaunchco.info",
    );
  });
});
