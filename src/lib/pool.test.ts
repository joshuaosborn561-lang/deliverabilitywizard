import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandRootFromParent,
  generateDomainSpins,
  isValidAffix,
  spinDomainName,
} from "./domainNaming.js";
import {
  buildPoolSignature,
  parsePersonName,
  poolEspFromSmartleadType,
} from "./poolSignature.js";
import {
  canBuyDomain,
  canCreateMailboxes,
  emptyMonthlyUsage,
} from "./monthlyCaps.js";

describe("domainNaming", () => {
  it("derives brand roots from parents", () => {
    assert.equal(brandRootFromParent("meet-connect.com"), "meetconnect");
    assert.equal(brandRootFromParent("theoutreachdesk.com"), "outreachdesk");
    assert.equal(brandRootFromParent("getintroduced.io"), "getintroduced");
  });

  it("rejects affixes longer than 3 letters", () => {
    assert.equal(isValidAffix("get"), true);
    assert.equal(isValidAffix("lab"), true);
    assert.equal(isValidAffix("clear"), false);
    assert.throws(() => spinDomainName("x.com", "clear", "pre"));
  });

  it("builds pre/suf spins", () => {
    assert.equal(
      spinDomainName("meet-connect.com", "get", "pre").domain,
      "getmeetconnect.info",
    );
    assert.equal(
      spinDomainName("meet-connect.com", "lab", "suf").domain,
      "meetconnectlab.info",
    );
  });

  it("generates multiple candidates", () => {
    const spins = generateDomainSpins("quickconnectsales.com");
    assert.ok(spins.length >= 10);
    assert.ok(spins.every((s) => s.domain.endsWith(".info")));
  });
});

describe("poolSignature", () => {
  it("formats First Last + brand", () => {
    assert.equal(
      buildPoolSignature({
        firstName: "Jo",
        lastName: "Shmo",
        clientBrand: "Parlay Tech",
      }),
      "Jo Shmo\nParlay Tech",
    );
  });

  it("maps Smartlead types to pool ESP", () => {
    assert.equal(poolEspFromSmartleadType("GMAIL"), "GOOGLE");
    assert.equal(poolEspFromSmartleadType("OUTLOOK"), "MICROSOFT");
    assert.equal(poolEspFromSmartleadType("SMTP"), null);
  });

  it("parses from_name", () => {
    assert.deepEqual(parsePersonName("Marty Moen"), {
      firstName: "Marty",
      lastName: "Moen",
    });
  });
});

describe("monthlyCaps", () => {
  it("enforces $25 domain budget", () => {
    const usage = emptyMonthlyUsage("2026-07");
    usage.domainSpendUsd = 22;
    const blocked = canBuyDomain(usage, 3.6, 25);
    assert.equal(blocked.ok, false);
    const ok = canBuyDomain({ ...usage, domainSpendUsd: 20 }, 3.6, 25);
    assert.equal(ok.ok, true);
  });

  it("enforces 25 mailbox / month", () => {
    const usage = emptyMonthlyUsage("2026-07");
    usage.mailboxesCreated = 23;
    assert.equal(canCreateMailboxes(usage, 3, 25).ok, false);
    assert.equal(canCreateMailboxes(usage, 2, 25).ok, true);
  });
});
