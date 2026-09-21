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

  it("D198: real client_id on a generic is dedicated (not forced to Goliath)", () => {
    // Pre-D198 this returned Goliath (D76 leftover scrub). Josh 2026-09-21:
    // assigning client_id on a pool mailbox dedicates it to that client.
    assert.equal(
      ownerClientId(
        548610,
        [
          { campaignId: 1, clientId: 548611, shell: false },
          { campaignId: 2, clientId: 548610, shell: false },
        ],
        { generic: true, genericOwnerId: 548611, markerClientId: false },
      ),
      548610,
    );
    assert.equal(
      ownerClientId(null, [
        { campaignId: 2, clientId: 548610, shell: false },
        { campaignId: 3, clientId: 99, shell: false },
      ], { generic: true, genericOwnerId: 548611 }),
      548611,
    );
  });
});

describe("ownerClientId D198 dedicated generics", () => {
  it("dedicated generic with real client_id is owned by that client, not Goliath", () => {
    assert.equal(
      ownerClientId(521881, [{ campaignId: 1, clientId: 521881, shell: false }], {
        generic: true,
        genericOwnerId: 111, // Goliath
        markerClientId: false,
      }),
      521881,
    );
  });

  it("free-pool generic still belongs to Goliath (D76)", () => {
    assert.equal(
      ownerClientId(null, [{ campaignId: 1, clientId: 521881, shell: false }], {
        generic: true,
        genericOwnerId: 111,
      }),
      111,
    );
  });

  it("marker client_id on a generic still belongs to Goliath", () => {
    assert.equal(
      ownerClientId(999, [{ campaignId: 1, clientId: 521881, shell: false }], {
        generic: true,
        genericOwnerId: 111,
        markerClientId: true,
      }),
      111,
    );
  });
});
