import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foreignCampaignIds, ownerClientId, peelCampaignIds } from "./oneClient.js";

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

  it("gives a leftover-tagged generic to Goliath (D76)", () => {
    assert.equal(
      ownerClientId(
        548610,
        [
          { campaignId: 1, clientId: 548611, shell: false },
          { campaignId: 2, clientId: 548610, shell: false },
        ],
        { generic: true, genericOwnerId: 548611 },
      ),
      548611,
    );
    assert.equal(
      ownerClientId(null, [
        { campaignId: 2, clientId: 548610, shell: false },
        { campaignId: 3, clientId: 99, shell: false },
      ], { generic: true, genericOwnerId: 548611 }),
      548611,
    );
  });

  it("gives a dedicated named-client generic to that client (D198)", () => {
    assert.equal(
      ownerClientId(
        77,
        [{ campaignId: 10, clientId: 77, shell: false }],
        { generic: true, genericOwnerId: 548611, dedicatedClientId: 77 },
      ),
      77,
    );
    assert.deepEqual(
      foreignCampaignIds(77, [
        { campaignId: 10, clientId: 77, shell: false },
        { campaignId: 20, clientId: 88, shell: false },
      ]),
      [20],
      "a dedicated Parlay seat on TechEvo is still foreign",
    );
  });
});

describe("D200 exclusive-attach is pool generics only", () => {
  const techevoA = { campaignId: 3847798, clientId: 521881, shell: false };
  const techevoB = { campaignId: 3847801, clientId: 521881, shell: false };
  const parlay = { campaignId: 10, clientId: 77, shell: false };
  const shell = { campaignId: 99, clientId: 521881, shell: true };

  it("does not peel a same-client named seat on two TechEvo camps", () => {
    assert.deepEqual(
      peelCampaignIds(521881, [techevoA, techevoB, shell], {
        poolGeneric: false,
      }),
      [],
      "named techevolution* on two TechEvo camps stays",
    );
  });

  it("peels a pool generic multi-linked across two same-client camps", () => {
    assert.deepEqual(
      peelCampaignIds(521881, [techevoA, techevoB, shell], {
        poolGeneric: true,
      }),
      [3847798],
      "pool generic keeps the last TechEvo camp and peels the extra",
    );
  });

  it("still peels a foreign-client tag on a named seat", () => {
    assert.deepEqual(
      peelCampaignIds(521881, [techevoA, parlay], { poolGeneric: false }),
      [10],
      "Parlay on a TechEvo-owned named seat is foreign",
    );
  });

  it("peels foreign plus extra same-client links on a pool generic", () => {
    assert.deepEqual(
      peelCampaignIds(521881, [techevoA, techevoB, parlay], {
        poolGeneric: true,
      }),
      [10, 3847798],
    );
  });
});
