import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { peelCampaignIds } from "./oneClient.js";
import {
  BOLDER_CLIENT_ID,
  isPowerGrydCampaignId,
  isPowerGrydClientId,
  isPowerGrydDedicatedSeat,
  isPowerGrydHay,
  isPowerGrydLeaveAlone,
  isPowerGrydMailboxId,
  POWERGRYD_BRAND,
  POWERGRYD_CAMPAIGN_IDS,
  POWERGRYD_CLIENT_ID,
  POWERGRYD_MAILBOX_IDS,
  powerGrydMailboxSignature,
} from "./powerGryd.js";

describe("D204 PowerGryd dedicated seats", () => {
  it("enumerates Josh's 40 mailbox ids and 12 campaign ids", () => {
    assert.equal(POWERGRYD_MAILBOX_IDS.length, 40);
    assert.equal(new Set(POWERGRYD_MAILBOX_IDS).size, 40);
    assert.equal(POWERGRYD_CAMPAIGN_IDS.length, 12);
    assert.equal(POWERGRYD_CLIENT_ID, 592842);
    assert.equal(POWERGRYD_BRAND, "PowerGRYD");
    assert.equal(BOLDER_CLIENT_ID, 542838);
    assert.equal(isPowerGrydMailboxId(21592105), true);
    assert.equal(isPowerGrydMailboxId(21831474), true);
    assert.equal(isPowerGrydMailboxId(1), false);
    assert.equal(isPowerGrydCampaignId(4005235), true);
    assert.equal(isPowerGrydCampaignId(3763803), false);
    assert.equal(isPowerGrydDedicatedSeat({ id: 21592105 }), true);
    assert.equal(isPowerGrydDedicatedSeat({ id: 11 }), false);
    assert.equal(isPowerGrydClientId(592842), true);
    assert.equal(isPowerGrydClientId(548611), false);
  });

  it("matches PowerGryd hay even when POC patterns are Goliath-only", () => {
    assert.equal(isPowerGrydHay("PowerGRYD MSP"), true);
    assert.equal(isPowerGrydHay("Jesse Miller Power Gryd"), true);
    assert.equal(isPowerGrydHay("Goliath Displacement"), false);
    assert.equal(
      isPowerGrydLeaveAlone({
        clientId: POWERGRYD_CLIENT_ID,
        campaignId: 4005218,
        campaignName: "PowerGRYD MSP",
      }),
      true,
    );
    assert.equal(
      isPowerGrydLeaveAlone({
        clientId: 548611,
        campaignName: "Goliath MDR",
      }),
      false,
    );
  });

  it("locks the two-line PowerGRYD signature", () => {
    assert.equal(
      powerGrydMailboxSignature("Ada Pool"),
      "Ada Pool\nPowerGRYD",
    );
    assert.equal(powerGrydMailboxSignature("  "), null);
  });

  it("same-client fan-out is not a D200 peel (named, not pool-generic)", () => {
    const memberships = POWERGRYD_CAMPAIGN_IDS.map((campaignId) => ({
      campaignId,
      clientId: POWERGRYD_CLIENT_ID,
      shell: false,
    }));
    assert.deepEqual(
      peelCampaignIds(POWERGRYD_CLIENT_ID, memberships, { poolGeneric: false }),
      [],
      "all 12 PowerGryd camps stay — these 40 are named seats",
    );
    assert.deepEqual(
      peelCampaignIds(
        POWERGRYD_CLIENT_ID,
        [
          ...memberships,
          { campaignId: 3763803, clientId: BOLDER_CLIENT_ID, shell: false },
        ],
        { poolGeneric: false },
      ),
      [3763803],
      "Bolder leftover still peels; PowerGryd camps do not",
    );
  });
});
