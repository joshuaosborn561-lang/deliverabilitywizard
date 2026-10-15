import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TECHEVO_CLIENT_ID, minFloorForClient } from "../canon/constants.js";
import {
  azureWouldReplaceGoogle,
  displayShortfall,
  displayStaffable,
  isStaffableSender,
  mailboxWeight,
  owesWarmup,
  understaffed,
} from "./staffable.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

function account(partial: Partial<SlimAccount> & Pick<SlimAccount, "id" | "email">): SlimAccount {
  return {
    fromName: "Ada Lovelace",
    clientId: 1,
    campaignIds: [10],
    tags: ["POD-A"],
    smtpOk: true,
    imapOk: true,
    messagePerDay: 30,
    warmupBlocked: false,
    createdAt: "2020-01-01T00:00:00.000Z",
    warmupStartedAt: "2020-01-01T00:00:00.000Z",
    signature: "Ada Lovelace\nAcme",
    ...partial,
  };
}

describe("staffable / floors", () => {
  it("D256: TechEvo floor is 30, everyone else 40", () => {
    assert.equal(minFloorForClient(TECHEVO_CLIENT_ID), 30);
    assert.equal(minFloorForClient(1), 40);
  });

  it("D232: Azure weighs 0.1", () => {
    const azure = account({
      id: 1,
      email: "a@tidalstackco.com",
      tags: ["type:azure", "POD-A"],
    });
    assert.equal(mailboxWeight(azure), 0.1);
  });

  it("D227: WARMUP-GATE-EXEMPT does not owe warmup", () => {
    const young = account({
      id: 2,
      email: "young@x.info",
      createdAt: new Date().toISOString(),
      warmupStartedAt: new Date().toISOString(),
      tags: ["WARMUP-GATE-EXEMPT", "POD-A"],
    });
    assert.equal(owesWarmup(young, []), false);
  });

  it("D105: a 1-day seat owes warmup", () => {
    const young = account({
      id: 3,
      email: "young@x.info",
      createdAt: new Date().toISOString(),
      warmupStartedAt: new Date().toISOString(),
      tags: ["POD-A"],
    });
    assert.equal(owesWarmup(young, []), true);
    assert.equal(isStaffableSender(young), false);
  });

  it("D233: Azure cannot replace Google", () => {
    const google = account({ id: 4, email: "g@gmail.info", tags: ["type:google"] });
    const azure = account({ id: 5, email: "a@tidalstackco.com", tags: ["type:azure"] });
    assert.equal(azureWouldReplaceGoogle(google, azure), true);
  });

  it("D259: shortfall ceils, staffable floors", () => {
    assert.equal(displayShortfall(0.1), 1);
    assert.equal(displayStaffable(39.9), 39);
  });

  it("D217: an ACTIVE campaign with one staffable seat is understaffed", () => {
    const campaign: SlimCampaign = {
      id: 10,
      name: "Acme",
      status: "ACTIVE",
      clientId: 1,
    };
    const seats = [
      account({
        id: 1,
        email: "a@x.info",
        tags: [],
      }),
    ];
    assert.equal(understaffed(campaign, seats), 39);
  });
});
