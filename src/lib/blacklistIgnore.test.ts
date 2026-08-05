import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterTeardownBlacklistHits,
  domainsSafeToReplace,
  diagnoseBlacklists,
} from "./blacklistDiagnosis.js";
import {
  isIgnoredBlacklistName,
  isTeardownIgnoredBlacklistHit,
} from "./blacklistIgnore.js";

describe("SURBL omit for teardown", () => {
  it("recognizes SURBL / URIBL list names", () => {
    assert.equal(isIgnoredBlacklistName("SURBL"), true);
    assert.equal(isIgnoredBlacklistName("multi.surbl.org"), true);
    assert.equal(isIgnoredBlacklistName("URIBL multi"), true);
    assert.equal(isIgnoredBlacklistName("Spamhaus ZEN"), false);
  });

  it("ignores unnamed SmartDelivery domain-blacklist hits", () => {
    assert.equal(
      isTeardownIgnoredBlacklistHit({ source: "domain-blacklist" }),
      true,
    );
    assert.equal(
      isTeardownIgnoredBlacklistHit({
        source: "domain-blacklist",
        listName: "Spamhaus DBL",
      }),
      false,
    );
  });

  it("filters SURBL and unnamed hits out of teardown set", () => {
    const kept = filterTeardownBlacklistHits([
      { domain: "a.info", source: "domain-blacklist" },
      {
        domain: "b.info",
        source: "ip-blacklist",
        listName: "SURBL",
        ip: "1.1.1.1",
      },
      {
        domain: "c.info",
        source: "ip-blacklist",
        listName: "Spamhaus ZEN",
        ip: "2.2.2.2",
      },
    ]);
    assert.deepEqual(
      kept.map((h) => h.domain),
      ["c.info"],
    );
  });

  it("does not mark SURBL-only domain_burned hits as replaceable", () => {
    const diagnoses = diagnoseBlacklists([
      {
        domain: "noisy.info",
        source: "domain-blacklist",
        listName: "SURBL",
      },
    ]);
    assert.deepEqual(domainsSafeToReplace(diagnoses), []);
  });
});
