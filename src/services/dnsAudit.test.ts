import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain, isCritical } from "./dnsAudit.js";

const ok = {
  txt: ["v=spf1 include:spf.protection.outlook.com -all"],
  dmarc: ["v=DMARC1; p=reject"],
  mx: ["x.mail.protection.outlook.com"],
};

describe("classifyDomain", () => {
  it("passes a correctly configured domain", () => {
    const a = classifyDomain("good.info", 3, ok);
    assert.deepEqual(a.issues, []);
    assert.equal(isCritical(a), false);
  });

  it("flags a domain with no SPF record as critical", () => {
    // The live parlaytech failure: DMARC and MX present, SPF absent.
    const a = classifyDomain("parlaytechnow.info", 3, { ...ok, txt: [] });
    assert.ok(a.issues.includes("no-spf"));
    assert.equal(isCritical(a), true);
  });

  it("flags multiple SPF records as critical (RFC 7208 permerror)", () => {
    const a = classifyDomain("dupe.info", 3, {
      ...ok,
      txt: ["v=spf1 include:_spf.google.com ~all", "v=spf1 include:x ~all"],
    });
    assert.ok(a.issues.includes("multiple-spf"));
    assert.equal(isCritical(a), true);
  });

  it("flags a neutral ?all as an issue but not critical", () => {
    const a = classifyDomain("neutral.com", 1, {
      ...ok,
      txt: ["v=spf1 +a +mx ?all"],
    });
    assert.ok(a.issues.includes("spf-neutral-all"));
    assert.equal(isCritical(a), false);
  });

  it("flags SPF with no all-qualifier", () => {
    const a = classifyDomain("noall.info", 1, {
      ...ok,
      txt: ["v=spf1 include:_spf.google.com"],
    });
    assert.ok(a.issues.includes("spf-no-all"));
  });

  it("reports an unresolvable domain and stops there", () => {
    const a = classifyDomain("gone.com", 2, { txt: null, dmarc: null, mx: null });
    assert.deepEqual(a.issues, ["unresolvable"]);
    assert.equal(isCritical(a), true);
  });

  it("flags missing DMARC and MX without calling them critical", () => {
    const a = classifyDomain("bare.info", 1, {
      txt: ["v=spf1 include:_spf.google.com ~all"],
      dmarc: [],
      mx: [],
    });
    assert.ok(a.issues.includes("no-dmarc"));
    assert.ok(a.issues.includes("no-mx"));
    assert.equal(isCritical(a), false, "deliverability gaps, not auth failures");
  });

  it("ignores unrelated TXT records when finding SPF", () => {
    const a = classifyDomain("mixed.info", 1, {
      ...ok,
      txt: ["google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"],
    });
    assert.deepEqual(a.issues, []);
  });
});
