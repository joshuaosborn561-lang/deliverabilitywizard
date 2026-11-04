import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIOTOLA_CAMPAIGN_IDS,
  CIOTOLA_CLIENT_ID,
  GABE_CALLS_CIOTOLA_ID,
  JEREMY_CIOTOLA_TAG,
  JEREMY_CIOTOLA_TAG_ID,
  ciotolaCrossoverCampaignIds,
  ciotolaExemptFromGenericTopUp,
  ciotolaExemptFromSenderTopUp,
  ciotolaMayAttach,
  ciotolaOwnedClientId,
  ciotolaStrayCampaignIds,
  isCiotolaCampaign,
  isCiotolaClientId,
  isGabeCallsCiotolaCampaign,
  isJeremyCiotolaSeat,
} from "./ciotolaClient.js";

const jeremy = {
  tags: [
    { id: JEREMY_CIOTOLA_TAG_ID, tag_name: JEREMY_CIOTOLA_TAG },
    { tag_name: "POD-A" },
  ],
};
const reserved = { tags: [{ tag_name: "GABE-VM-RESERVED" }] };
const sgSeat = { tags: [{ tag_name: "POD-A" }] };

const ciotolaNamed = { id: 4289735, name: "Ciotola Engagers" };
const ciotolaPrefix = { id: 99, name: "Ciotola Outbound A" };
const gabeCiotola = { id: GABE_CALLS_CIOTOLA_ID, name: "Gabe Calls | Ciotola" };
const sgCampaign = { id: 3122546, name: "SalesGlider Engagers" };

describe("D325 Ciotola / JEREMY-CIOTOLA isolation", () => {
  it("recognises the tag by name or id 533700, with or without a POD tag", () => {
    assert.equal(isJeremyCiotolaSeat(jeremy), true);
    assert.equal(isJeremyCiotolaSeat({ tags: [{ tag_name: "jeremy-ciotola" }] }), true);
    assert.equal(isJeremyCiotolaSeat({ tags: [{ id: 533700 }] }), true);
    assert.equal(
      isJeremyCiotolaSeat({
        tags: [{ id: 533700, tag_name: "JEREMY-CIOTOLA" }, { tag_name: "POD-B" }],
      }),
      true,
    );
    assert.equal(isJeremyCiotolaSeat(sgSeat), false);
    assert.equal(isJeremyCiotolaSeat(reserved), false);
  });

  it("recognises Ciotola campaigns by prefix or explicit id", () => {
    assert.ok(CIOTOLA_CAMPAIGN_IDS.includes(4289735));
    assert.equal(isCiotolaCampaign(ciotolaNamed), true);
    assert.equal(isCiotolaCampaign(ciotolaPrefix), true);
    assert.equal(isCiotolaCampaign(gabeCiotola), true);
    assert.equal(isCiotolaCampaign({ id: 4289738, name: "SG leftover" }), true);
    assert.equal(isCiotolaCampaign(sgCampaign), false);
    assert.equal(isGabeCallsCiotolaCampaign(gabeCiotola), true);
    assert.equal(isGabeCallsCiotolaCampaign(ciotolaNamed), false);
  });

  it("treats Ciotola as its own virtual client for POD counts", () => {
    assert.equal(ciotolaOwnedClientId(jeremy), CIOTOLA_CLIENT_ID);
    assert.equal(ciotolaOwnedClientId(sgSeat), null);
    assert.equal(isCiotolaClientId(CIOTOLA_CLIENT_ID), true);
    assert.equal(isCiotolaClientId(345263), false);
    assert.equal(ciotolaExemptFromGenericTopUp(CIOTOLA_CLIENT_ID), true);
    assert.equal(ciotolaExemptFromSenderTopUp(ciotolaNamed), true);
    assert.equal(ciotolaExemptFromSenderTopUp(sgCampaign), false);
  });

  it("lets Jeremy attach only to Ciotola campaigns", () => {
    const noPod = { tags: [{ id: 533700, tag_name: "JEREMY-CIOTOLA" }] };
    assert.equal(ciotolaMayAttach({ account: jeremy, campaign: ciotolaNamed }).ok, true);
    assert.equal(ciotolaMayAttach({ account: jeremy, campaign: gabeCiotola }).ok, true);
    assert.equal(ciotolaMayAttach({ account: jeremy, campaign: sgCampaign }).ok, false);
    assert.equal(ciotolaMayAttach({ account: noPod, campaign: sgCampaign }).ok, false);
    assert.match(
      ciotolaMayAttach({ account: jeremy, campaign: sgCampaign }).reason,
      /never fans out/,
    );
  });

  it("keeps non-Jeremy off Ciotola except GABE-VM-RESERVED on 4236534", () => {
    assert.equal(ciotolaMayAttach({ account: sgSeat, campaign: ciotolaNamed }).ok, false);
    assert.equal(ciotolaMayAttach({ account: reserved, campaign: ciotolaNamed }).ok, false);
    assert.equal(ciotolaMayAttach({ account: reserved, campaign: gabeCiotola }).ok, true);
    assert.equal(ciotolaMayAttach({ account: sgSeat, campaign: gabeCiotola }).ok, false);
    assert.equal(ciotolaMayAttach({ account: sgSeat, campaign: sgCampaign }).ok, true);
  });

  it("lists SG memberships as crossover for a Jeremy seat", () => {
    assert.deepEqual(
      ciotolaCrossoverCampaignIds({
        account: jeremy,
        memberships: [
          { campaignId: 4289735, campaign: ciotolaNamed },
          { campaignId: 3122546, campaign: sgCampaign },
          { campaignId: 1, shell: true, campaign: sgCampaign },
        ],
      }),
      [3122546],
    );
    assert.deepEqual(
      ciotolaCrossoverCampaignIds({
        account: sgSeat,
        memberships: [{ campaignId: 3122546, campaign: sgCampaign }],
      }),
      [],
    );
  });

  it("lists regular Ciotola memberships as stray for a non-Jeremy seat", () => {
    assert.deepEqual(
      ciotolaStrayCampaignIds({
        account: sgSeat,
        memberships: [
          { campaignId: 4289735, campaign: ciotolaNamed },
          { campaignId: GABE_CALLS_CIOTOLA_ID, campaign: gabeCiotola },
          { campaignId: 3122546, campaign: sgCampaign },
        ],
      }),
      [4289735, GABE_CALLS_CIOTOLA_ID],
    );
    assert.deepEqual(
      ciotolaStrayCampaignIds({
        account: reserved,
        memberships: [
          { campaignId: 4289735, campaign: ciotolaNamed },
          { campaignId: GABE_CALLS_CIOTOLA_ID, campaign: gabeCiotola },
        ],
      }),
      [4289735],
    );
  });
});
