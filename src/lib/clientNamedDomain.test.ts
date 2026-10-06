import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import { StateStore } from "../state/store.js";
import {
  CULTURE_FITS_CLIENT_ID,
  clientNamedOwnerForDomain,
  clientNamedSlugInDomain,
  isClientNamedDomain,
  isClientNamedMailbox,
  isClientNamedSlugDomain,
  isCultureFitsDomain,
  migrateClientNamedPoolRecords,
  planClientNamedPodSplit,
} from "./clientNamedDomain.js";

const CLIENTS = [
  { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
  { id: 521881, name: "TechEvo", logo: "TechEvolution" },
  { id: 418275, name: "TJ Johnson", logo: "Culture Fits" },
  { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
];

describe("D243 client-named domains", () => {
  it("matches Josh's brand slugs and list_clients names", () => {
    assert.equal(clientNamedSlugInDomain("goliathcybersecurityget.info"), "goliathcybersecurity");
    assert.equal(clientNamedSlugInDomain("trygoliathcybersecurity.info"), "goliathcybersecurity");
    assert.equal(clientNamedSlugInDomain("techevolutiononeget.info"), "techevolution");
    assert.equal(clientNamedSlugInDomain("trytechevolutionone.info"), "techevolution");
    assert.equal(isClientNamedDomain("salesgliderbox.info"), true);
    assert.equal(isClientNamedDomain("getboldercyperpartner.info"), true);
    assert.equal(isClientNamedDomain("emcorgo.info"), true);
    assert.equal(isClientNamedDomain("tryparlay.info"), true);
    assert.equal(isClientNamedDomain("powergrydnow.info"), true);
    assert.equal(isClientNamedDomain("deeprootscapital.info"), true);
    assert.equal(isClientNamedDomain("joshosbornhq.info"), true);
    assert.equal(
      isClientNamedDomain("cornerstoneearthworksmy.info", [
        { id: 12, name: "CornerStone", logo: "CornerStone Earthworks" },
      ]),
      true,
    );
    assert.equal(isClientNamedSlugDomain("trygetintroduced.info"), false);
    assert.equal(isClientNamedDomain("crosslaunchco.com"), false);
  });

  it("Culture Fits 418275 / culturefits* is not a named seat", () => {
    assert.equal(isCultureFitsDomain("culturefitsnow.com"), true);
    assert.equal(isClientNamedDomain("culturefitsnow.com", CLIENTS), false);
    assert.equal(isClientNamedSlugDomain("tryculturefits.info"), false);
    assert.equal(clientNamedOwnerForDomain("culturefitsnow.com", CLIENTS), null);
    assert.equal(CULTURE_FITS_CLIENT_ID, 418275);
  });

  it("resolves Goliath 548611 and TechEvo 521881 owners", () => {
    assert.deepEqual(clientNamedOwnerForDomain("goliathcybersecuritygo.info", CLIENTS), {
      clientId: 548611,
      clientName: "Goliath Cybersecurity",
    });
    assert.deepEqual(clientNamedOwnerForDomain("techevolutiononeget.info", CLIENTS), {
      clientId: 521881,
      clientName: "TechEvolution",
    });
  });

  it("already-tagged POD-A/POD-B seats are not re-split", () => {
    const plan = planClientNamedPodSplit([
      {
        email: "a1@goliathcybersecurityget.info",
        type: "GMAIL",
        tags: [{ tag_name: "POD-A" }],
      },
      {
        email: "b1@goliathcybersecurityget.info",
        type: "GMAIL",
        tags: [{ tag_name: "POD-B" }],
      },
      {
        email: "new@goliathcybersecurityget.info",
        type: "OUTLOOK",
        tags: [],
      },
    ]);
    assert.equal(plan.get("a1@goliathcybersecurityget.info"), "A");
    assert.equal(plan.get("b1@goliathcybersecurityget.info"), "B");
    assert.ok(
      plan.get("new@goliathcybersecurityget.info") === "A" ||
        plan.get("new@goliathcybersecurityget.info") === "B",
    );
  });

  it("migrates leftover pool records and generic-table rows; leaves Culture Fits", async () => {
    const state = new StateStore(
      `/tmp/d243-migrate-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "ada@goliathcybersecurityget.info",
      domain: "goliathcybersecurityget.info",
      platform: "GOOGLE",
      firstName: "Ada",
      lastName: "Lovelace",
      status: "available",
      warmedAt: "2026-09-22T00:00:00.000Z",
    });
    state.upsertPoolMailbox({
      email: "tj@culturefitsnow.com",
      domain: "culturefitsnow.com",
      platform: "GOOGLE",
      firstName: "TJ",
      lastName: "Johnson",
      status: "available",
    });
    state.upsertGenericSeat(
      emptyGenericSeat("ada@goliathcybersecurityget.info", {
        assignedClientId: 99,
        assignedPod: "A",
      }),
    );
    state.upsertGenericSeat(emptyGenericSeat("tj@culturefitsnow.com"));

    const result = migrateClientNamedPoolRecords({
      state,
      accounts: [
        {
          from_email: "ada@goliathcybersecurityget.info",
          tags: [{ tag_name: "POD-A" }],
        },
        {
          from_email: "tj@culturefitsnow.com",
          tags: [{ tag_name: "GENERIC" }],
        },
      ],
      clients: CLIENTS,
    });

    assert.deepEqual(result.removedPool, ["ada@goliathcybersecurityget.info"]);
    assert.ok(result.droppedSeats.includes("ada@goliathcybersecurityget.info"));
    assert.ok(result.alreadyTagged.includes("ada@goliathcybersecurityget.info"));
    assert.equal(state.getPoolMailbox("ada@goliathcybersecurityget.info"), undefined);
    assert.equal(state.getGenericSeat("ada@goliathcybersecurityget.info"), undefined);
    assert.ok(state.getPoolMailbox("tj@culturefitsnow.com"));
    assert.ok(state.getGenericSeat("tj@culturefitsnow.com"));
    assert.equal(isClientNamedMailbox("ada@goliathcybersecurityget.info"), true);
    assert.equal(isClientNamedMailbox("tj@culturefitsnow.com"), false);
  });
});
