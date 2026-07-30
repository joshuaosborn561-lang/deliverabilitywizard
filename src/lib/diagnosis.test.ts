import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diagnoseBlacklists,
  domainsSafeToReplace,
} from "./blacklistDiagnosis.js";
import {
  authVerdictOf,
  dkimFailing,
  parseSenderAuthResults,
  spfFailing,
} from "./authResults.js";
import type { BlacklistedDomainHit } from "../types/index.js";

describe("diagnoseBlacklists", () => {
  it("calls a domain burned when the domain itself is listed", () => {
    const hits: BlacklistedDomainHit[] = [
      {
        domain: "parlaytechlab.info",
        source: "domain-blacklist",
        totalHits: 2,
      },
    ];
    const [d] = diagnoseBlacklists(hits);
    assert.equal(d!.verdict, "domain_burned");
    assert.match(d!.recommendation, /burned/i);
  });

  it("flags a shared IP when one listed IP carries several of our domains", () => {
    const hits: BlacklistedDomainHit[] = [
      {
        domain: "alpha.info",
        source: "ip-blacklist",
        ip: "1.2.3.4",
        listName: "Spamhaus ZEN",
      },
      {
        domain: "beta.info",
        source: "ip-blacklist",
        ip: "1.2.3.4",
        listName: "Spamhaus ZEN",
      },
    ];
    const diagnoses = diagnoseBlacklists(hits);
    assert.equal(diagnoses.length, 2);
    for (const d of diagnoses) {
      assert.equal(d.verdict, "shared_ip");
      assert.match(d.recommendation, /do NOT replace/i);
    }
    assert.deepEqual(diagnoses[0]!.sharedWithDomains, ["beta.info"]);
  });

  it("keeps a lone listed IP separate from a shared one", () => {
    const hits: BlacklistedDomainHit[] = [
      { domain: "solo.info", source: "ip-blacklist", ip: "9.9.9.9" },
    ];
    const [d] = diagnoseBlacklists(hits);
    assert.equal(d!.verdict, "domain_ip");
    assert.deepEqual(d!.sharedWithDomains, []);
  });

  it("only auto-replaces genuinely burned domains", () => {
    const hits: BlacklistedDomainHit[] = [
      { domain: "burned.info", source: "domain-blacklist" },
      { domain: "a.info", source: "ip-blacklist", ip: "1.1.1.1" },
      { domain: "b.info", source: "ip-blacklist", ip: "1.1.1.1" },
    ];
    assert.deepEqual(domainsSafeToReplace(diagnoseBlacklists(hits)), [
      "burned.info",
    ]);
  });
});

describe("authVerdictOf", () => {
  it("reads bare verdicts", () => {
    assert.equal(authVerdictOf("Pass", "spf"), "pass");
    assert.equal(authVerdictOf("Fail", "spf"), "fail");
  });

  it("reads Authentication-Results blobs", () => {
    assert.equal(
      authVerdictOf("spf=fail (google.com: domain of x does not designate)", "spf"),
      "fail",
    );
    assert.equal(authVerdictOf("dkim=pass header.i=@x.com", "dkim"), "pass");
  });

  it("treats softfail and permerror as failures", () => {
    assert.equal(authVerdictOf("spf=softfail", "spf"), "fail");
    assert.equal(authVerdictOf("spf=permerror", "spf"), "fail");
  });

  it("returns unknown for missing data", () => {
    assert.equal(authVerdictOf(undefined, "spf"), "unknown");
    assert.equal(authVerdictOf("", "spf"), "unknown");
  });
});

describe("parseSenderAuthResults", () => {
  it("tallies per-sender SPF/DKIM across seed rows", () => {
    const raw = [
      {
        email: "angelomills@parlaytechnow.info",
        details: [
          { reply: { spf_result: "fail", dkim_result: "pass" } },
          { reply: { spf_result: "fail", dkim_result: "pass" } },
        ],
      },
    ];
    const [row] = parseSenderAuthResults(raw);
    assert.equal(row!.spfFail, 2);
    assert.equal(row!.spfPass, 0);
    assert.equal(row!.dkimPass, 2);
    assert.equal(spfFailing(row!), true);
    assert.equal(dkimFailing(row!), false);
  });

  it("does not call SPF broken when some seeds pass", () => {
    const raw = [
      {
        email: "x@y.info",
        details: [
          { reply: { spf_result: "pass" } },
          { reply: { spf_result: "fail" } },
        ],
      },
    ];
    const [row] = parseSenderAuthResults(raw);
    assert.equal(spfFailing(row!), false);
  });

  it("skips senders with no auth data at all", () => {
    assert.deepEqual(parseSenderAuthResults([{ email: "a@b.c", details: [] }]), []);
  });
});
