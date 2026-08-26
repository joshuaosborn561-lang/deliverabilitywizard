import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignIdFromCreate,
  isPodControlShellCampaign,
  POD_CONTROL_SHELL_NAME,
} from "./podControlShell.js";

describe("pod control shell identity", () => {
  it("matches the paused shell by name or pinned id", () => {
    assert.equal(
      isPodControlShellCampaign({ id: 1, name: POD_CONTROL_SHELL_NAME }),
      true,
    );
    assert.equal(
      isPodControlShellCampaign({ id: 9, name: "Acme Sports" }),
      false,
    );
    assert.equal(
      isPodControlShellCampaign({ id: 42, name: "Acme Sports" }, 42),
      true,
    );
  });

  it("reads a campaign id from create responses", () => {
    assert.equal(campaignIdFromCreate({ id: 123 }), 123);
    assert.equal(campaignIdFromCreate({ campaign_id: "456" }), 456);
    assert.equal(campaignIdFromCreate({ data: { id: 7 } }), 7);
  });
});
