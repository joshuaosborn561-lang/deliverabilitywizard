import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foreignCampaignIds, ownerClientId } from "./oneClient.js";

describe("one client per inbox (D75)", () => {
  it("keeps every campaign for the owner client and the shell", () => {
    const owner = ownerClientId(548611, [
      { campaignId: 1, clientId: 548611, shell: false },
      { campaignId: 2, clientId: 548611, shell: false },
      { campaignId: 99, clientId: 548611, shell: true },
    ]);
    assert.equal(owner, 548611);
    assert.deepEqual(
      foreignCampaignIds(owner, [
        { campaignId: 1, clientId: 548611, shell: false },
        { campaignId: 2, clientId: 548611, shell: false },
        { campaignId: 3, clientId: 99, shell: false },
        { campaignId: 99, clientId: 99, shell: true },
      ]),
      [3],
    );
  });

  it("uses the sole campaign client when the mailbox has no client_id", () => {
    assert.equal(
      ownerClientId(null, [{ campaignId: 1, clientId: 9, shell: false }]),
      9,
    );
    assert.equal(
      ownerClientId(null, [
        { campaignId: 1, clientId: 9, shell: false },
        { campaignId: 2, clientId: 10, shell: false },
      ]),
      null,
    );
  });
});
