import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { generateDomainSpins } from "./domainNaming.js";
import {
  filterReplacementSpins,
  isClientSendingDomain,
  isForbiddenGenericReplacement,
  isGenericSendingDomain,
  replacementBrandRoot,
  replacementParentForRetiredDomain,
  stripKnownAffixes,
} from "./retireReplacement.js";

function cfg() {
  return loadConfig({} as NodeJS.ProcessEnv);
}

describe("D161 — client-domain replace is client-named", () => {
  it("strips get/try/pro affixes down to the brand", () => {
    assert.equal(stripKnownAffixes("boldercyperpartnerpro"), "boldercyperpartner");
    assert.equal(stripKnownAffixes("getboldercyperpartner"), "boldercyperpartner");
    assert.equal(stripKnownAffixes("tryboldercyperpartner"), "boldercyperpartner");
  });

  it("BCP inventory all maps to boldercyperpartner", () => {
    for (const domain of [
      "boldercyperpartnerpro.info",
      "getboldercyperpartner.info",
      "tryboldercyperpartner.info",
      "keyboldercyperpartner.info",
      "boldercyperpartnerbiz.info",
      "boldercyperpartnerhub.info",
    ]) {
      assert.equal(
        replacementBrandRoot(domain),
        "boldercyperpartner",
        domain,
      );
    }
  });

  it("classifies BCP as client and crosslaunchco spins as generic", () => {
    const config = cfg();
    assert.equal(
      isClientSendingDomain("boldercyperpartnerpro.info", config),
      true,
    );
    assert.equal(
      isGenericSendingDomain("crosslaunchco.com", config),
      true,
    );
    assert.equal(
      isGenericSendingDomain("crosslaunchcotry.info", config),
      true,
      "tonight's wrong buy is a generic spin",
    );
    assert.equal(
      isGenericSendingDomain("getcrosslaunchco.info", config),
      true,
    );
    assert.equal(
      isGenericSendingDomain("getmeetconnect.info", config),
      true,
    );
  });

  it("client retire parent is the client brand, never isolationBuyParentDomain", () => {
    const config = cfg();
    const parent = replacementParentForRetiredDomain(
      "boldercyperpartnerpro.info",
      config,
      { requestedParent: config.isolationBuyParentDomain, kind: "buy_domains" },
    );
    assert.equal(parent, "boldercyperpartner.info");
    assert.doesNotMatch(parent, /crosslaunchco/);
    const spins = generateDomainSpins(parent);
    assert.ok(
      spins.some((s) => s.domain === "getboldercyperpartner.info"),
    );
    assert.ok(
      spins.some((s) => s.domain === "tryboldercyperpartner.info"),
    );
    assert.ok(
      spins.every((s) => s.domain.includes("boldercyperpartner")),
    );
    assert.ok(
      spins.every((s) => !s.domain.includes("crosslaunchco")),
    );
  });

  it("generic retire may still use the crosslaunchco parent", () => {
    const config = cfg();
    const parent = replacementParentForRetiredDomain(
      "crosslaunchco.com",
      config,
      { requestedParent: config.isolationBuyParentDomain, kind: "buy_domains" },
    );
    assert.equal(parent, config.isolationBuyParentDomain);
  });

  it("isolation-rig buy keeps the generic parent", () => {
    const config = cfg();
    assert.equal(
      replacementParentForRetiredDomain("", config, {
        requestedParent: config.isolationBuyParentDomain,
        kind: "buy_isolation_domain",
      }),
      config.isolationBuyParentDomain,
    );
  });

  it("refuses a generic candidate when the retired domain is a client domain", () => {
    const config = cfg();
    assert.equal(
      isForbiddenGenericReplacement(
        "boldercyperpartnerpro.info",
        "crosslaunchcotry.info",
        config,
      ),
      true,
    );
    assert.equal(
      isForbiddenGenericReplacement(
        "boldercyperpartnerpro.info",
        "getboldercyperpartner.info",
        config,
      ),
      false,
    );
    assert.equal(
      isForbiddenGenericReplacement(
        "crosslaunchco.com",
        "crosslaunchcotry.info",
        config,
      ),
      false,
      "generic→generic is allowed",
    );
  });

  it("filters generic spins out of a client-domain candidate list", () => {
    const config = cfg();
    const mixed = [
      ...generateDomainSpins("crosslaunchco.com"),
      ...generateDomainSpins("boldercyperpartner.info"),
    ];
    const kept = filterReplacementSpins(
      mixed,
      "boldercyperpartnerpro.info",
      config,
      new Set(["boldercyperpartnerpro.info"]),
    );
    assert.ok(kept.length > 0);
    assert.ok(kept.every((s) => s.domain.includes("boldercyperpartner")));
    assert.ok(kept.every((s) => !s.domain.includes("crosslaunchco")));
    assert.ok(
      !kept.some((s) => s.domain === "boldercyperpartnerpro.info"),
      "does not re-buy the retired domain",
    );
  });

  it("throws rather than fall back to a generic parent for a client domain", () => {
    const config = cfg();
    assert.throws(
      () =>
        replacementParentForRetiredDomain("x.info", {
          ...config,
          isolationBuyParentDomain: "crosslaunchco.com",
        }),
      /refusing a generic replacement \(D161\)|Cannot derive a client brand/,
    );
  });
});
