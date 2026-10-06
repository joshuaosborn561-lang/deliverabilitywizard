import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTAMINATED_CANARY_DOMAINS,
  COPY_CANARY_FLEET_SIZE,
  canaryFleetBuyAlreadyOpen,
  domainsFromCanaryBuyActions,
  fleetIsReady,
  fleetMeetsEspMinimum,
  isCopyCanaryFleetEmail,
  isReleasedCanaryDomain,
  isReleasedCanaryEmail,
  sanitizeCopyCanaryFleet,
} from "./copyCanaryFleet.js";

describe("D240 released canary fleet", () => {
  it("releases the contaminated 6-seat domains and constructed emails", () => {
    assert.equal(COPY_CANARY_FLEET_SIZE, 10);
    assert.equal(
      isReleasedCanaryEmail("leilasanchez@getcrosslaunchco.info"),
      true,
    );
    assert.equal(
      isReleasedCanaryEmail("kwamelopez@crosslaunchcoget.info"),
      true,
    );
    assert.equal(isReleasedCanaryDomain("getcrosslaunchco.info"), true);
    assert.equal(isReleasedCanaryDomain("crosslaunchcoget.info"), true);
    assert.equal(isReleasedCanaryEmail("ada@newcanary.test"), false);
    assert.equal(isReleasedCanaryDomain("newcanary.test"), false);
  });

  it("never treats a released email as fleet membership even if state still lists it", () => {
    const fleet = {
      status: "ready" as const,
      domains: [...CONTAMINATED_CANARY_DOMAINS],
      emails: ["leilasanchez@getcrosslaunchco.info"],
      googleDomain: "getcrosslaunchco.info",
      microsoftDomain: "crosslaunchcoget.info",
      updatedAt: "2026-10-05T00:00:00.000Z",
    };
    assert.equal(
      isCopyCanaryFleetEmail("leilasanchez@getcrosslaunchco.info", fleet),
      false,
    );
    const clean = sanitizeCopyCanaryFleet(fleet);
    assert.equal(clean?.emails.length, 0);
    assert.equal(clean?.status, "missing");
  });

  it("does not rebuild a buy action whose domains are released", () => {
    const bought = domainsFromCanaryBuyActions([
      {
        id: "old",
        kind: "buy_canary_fleet",
        status: "executed",
        detail: {
          domains: ["getcrosslaunchco.info", "crosslaunchcoget.info"],
          emails: ["leilasanchez@getcrosslaunchco.info"],
        },
      },
    ]);
    assert.equal(bought, null);
    assert.equal(
      canaryFleetBuyAlreadyOpen(null, [
        {
          kind: "buy_canary_fleet",
          status: "executed",
          detail: { domains: ["getcrosslaunchco.info"] },
        },
      ]),
      false,
    );
  });

  it("keeps the one-Google + one-Outlook minimum on a 10-seat / 4-domain fleet", () => {
    assert.equal(
      fleetMeetsEspMinimum({
        googleDomain: "g1.canary",
        microsoftDomain: "m1.canary",
        domains: ["g1.canary", "g2.canary", "m1.canary", "m2.canary"],
        googleDomains: ["g1.canary", "g2.canary"],
        microsoftDomains: ["m1.canary", "m2.canary"],
      }),
      true,
    );
    assert.equal(
      fleetMeetsEspMinimum({
        googleDomain: "g1.canary",
        domains: ["g1.canary"],
      }),
      false,
    );
    assert.equal(
      fleetIsReady({
        status: "ready",
        emails: [
          "a@g1.canary",
          "b@g1.canary",
          "c@g2.canary",
          "d@g2.canary",
          "e@g2.canary",
          "f@m1.canary",
          "g@m1.canary",
          "h@m2.canary",
          "i@m2.canary",
          "j@m2.canary",
        ],
        domains: ["g1.canary", "g2.canary", "m1.canary", "m2.canary"],
        googleDomain: "g1.canary",
        microsoftDomain: "m1.canary",
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      true,
    );
  });
});
