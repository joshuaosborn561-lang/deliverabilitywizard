import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterTeardownBlacklistHits,
  domainsSafeToReplace,
  diagnoseBlacklists,
} from "./blacklistDiagnosis.js";
import {
  filterCountableBlacklistHits,
  isCountableBlacklistHit,
  isIgnoredBlacklistName,
  isSurblListing,
  isTeardownIgnoredBlacklistHit,
} from "./blacklistIgnore.js";

describe("SURBL never counts as a blacklist hit (D210)", () => {
  it("recognizes SURBL names and any *.surbl.org zone", () => {
    assert.equal(isSurblListing("SURBL"), true);
    assert.equal(isSurblListing("multi.surbl.org"), true);
    assert.equal(isSurblListing("fresh.surbl.org"), true);
    assert.equal(isSurblListing(undefined, "listed at multi.surbl.org (127.0.0.64)"), true);
    assert.equal(isSurblListing("Spamhaus ZEN"), false);
    assert.equal(isSurblListing("URIBL multi"), false);
  });

  it("does not count SURBL as a hit; URIBL stays teardown-ignored only", () => {
    assert.equal(isIgnoredBlacklistName("SURBL"), true);
    assert.equal(isIgnoredBlacklistName("multi.surbl.org"), true);
    assert.equal(isIgnoredBlacklistName("URIBL multi"), true);
    assert.equal(isIgnoredBlacklistName("Spamhaus ZEN"), false);

    assert.equal(
      isCountableBlacklistHit({
        source: "ip-blacklist",
        listName: "multi.surbl.org",
        details: "127.0.0.64",
      }),
      false,
    );
    assert.equal(
      isCountableBlacklistHit({
        source: "domain-blacklist",
        listName: "SURBL",
      }),
      false,
    );
    assert.equal(
      isCountableBlacklistHit({ source: "domain-blacklist" }),
      false,
      "unnamed SmartDelivery domain-blacklist is SURBL noise",
    );
    assert.equal(
      isCountableBlacklistHit({
        source: "ip-blacklist",
        listName: "URIBL multi",
      }),
      true,
      "URIBL is still a named listing; teardown ignore is separate",
    );
    assert.equal(
      isCountableBlacklistHit({
        source: "ip-blacklist",
        listName: "Spamhaus ZEN",
      }),
      true,
    );
  });

  it("ignores unnamed SmartDelivery domain-blacklist hits for teardown", () => {
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

  it("SURBL-only listings produce no teardown, retire, or countable hit", () => {
    const hits = [
      { domain: "a.info", source: "domain-blacklist" as const },
      {
        domain: "b.info",
        source: "ip-blacklist" as const,
        listName: "SURBL",
        ip: "1.1.1.1",
      },
      {
        domain: "c.info",
        source: "ip-blacklist" as const,
        listName: "multi.surbl.org",
        details: "127.0.0.64",
        ip: "2.2.2.2",
      },
      {
        domain: "d.info",
        source: "ip-blacklist" as const,
        listName: "Spamhaus ZEN",
        ip: "3.3.3.3",
      },
    ];
    assert.deepEqual(
      filterTeardownBlacklistHits(hits).map((h) => h.domain),
      ["d.info"],
    );
    assert.deepEqual(
      filterCountableBlacklistHits(hits).map((h) => h.domain),
      ["d.info"],
    );
    assert.deepEqual(
      domainsSafeToReplace(diagnoseBlacklists(hits)),
      [],
      "SURBL-only domain_burned rows are not retire/replace candidates",
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
