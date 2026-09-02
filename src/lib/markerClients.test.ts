import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientDomainTokens,
  confidentClientForDomain,
  GENERIC_TAG,
  hasPoolMarkerTag,
  isPoolMarkerTag,
  POC_TAG,
} from "./markerClients.js";

const CLIENTS = [
  { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
  { id: 418274, name: "Randy Haba", logo: "Parlay Tech" },
  { id: 418275, name: "TJ Johnson", logo: "Culture Fits" },
  { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
  { id: 900001, name: "Generic", logo: "Generic" },
  { id: 900002, name: "POC", logo: "POC" },
];

describe("D142 confident domain→client matching", () => {
  it("derives distinctive tokens, never stop words or markers", () => {
    assert.deepEqual(clientDomainTokens(CLIENTS[0]!), ["salesglider"]);
    const parlay = clientDomainTokens(CLIENTS[1]!);
    assert.ok(parlay.includes("parlay"));
    assert.ok(parlay.includes("parlaytech"));
    assert.ok(!parlay.includes("tech"), "4-char words never match");
    assert.deepEqual(clientDomainTokens(CLIENTS[4]!), [], "markers never match");
    const goliath = clientDomainTokens(CLIENTS[3]!);
    assert.ok(goliath.includes("goliath"));
  });

  it("attaches only on exactly one matching client", () => {
    assert.equal(
      confidentClientForDomain("salesgliderbox.info", CLIENTS)?.clientId,
      345263,
    );
    assert.equal(
      confidentClientForDomain("winparlay.info", CLIENTS)?.clientId,
      418274,
    );
    assert.equal(
      confidentClientForDomain("culturefitsnow.com", CLIENTS)?.clientId,
      418275,
    );
    // The real unresolved case: no client token in the base — stays human.
    assert.equal(
      confidentClientForDomain("cornerstoneearthworksmy.info", CLIENTS),
      null,
    );
    // Two matching clients would be ambiguous.
    const doubled = [
      ...CLIENTS,
      { id: 999, name: "Parlay Partners", logo: null },
    ];
    assert.equal(confidentClientForDomain("winparlay.info", doubled), null);
  });
});

describe("D160 pool marker tags", () => {
  it("GENERIC and POC tags mark a mailbox, leftover client names do not match domains", () => {
    assert.equal(isPoolMarkerTag(GENERIC_TAG), true);
    assert.equal(isPoolMarkerTag(POC_TAG), true);
    assert.equal(isPoolMarkerTag("POD-A"), false);
    assert.equal(hasPoolMarkerTag({ tags: [{ tag_name: "GENERIC" }] }), true);
    assert.equal(hasPoolMarkerTag({ tags: [{ name: "poc" }] }), true);
    assert.equal(hasPoolMarkerTag({ tags: [{ tag_name: "POD-A" }] }), false);
    assert.equal(hasPoolMarkerTag({ tags: [] }), false);
  });
});
