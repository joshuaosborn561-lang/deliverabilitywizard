import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mailboxDomainOf } from "../clients/inboxkit.js";

describe("mailboxDomainOf", () => {
  it("prefers explicit domain_name", () => {
    assert.equal(
      mailboxDomainOf({ domain_name: "Alpha.INFO", email: "x@beta.info" }),
      "alpha.info",
    );
  });

  it("falls back to domain then to the email host", () => {
    assert.equal(mailboxDomainOf({ domain: "Beta.info" }), "beta.info");
    assert.equal(mailboxDomainOf({ email: "Jo@Gamma.info" }), "gamma.info");
    assert.equal(mailboxDomainOf({ address: "jo@delta.info" }), "delta.info");
  });

  it("returns empty when there is nothing to key on", () => {
    assert.equal(mailboxDomainOf({}), "");
  });

  it("distinguishes near-miss domains so a fuzzy match cannot cancel them", () => {
    // InboxKit's `keyword` filter is fuzzy: searching "parlaytech.info" can
    // return these, and cancelling them would destroy unrelated paid mailboxes.
    const target = "parlaytech.info";
    const returned = [
      { domain_name: "parlaytech.info" },
      { domain_name: "parlaytechnow.info" },
      { domain_name: "getparlaytech.info" },
    ];
    const kept = returned.filter((m) => mailboxDomainOf(m) === target);
    assert.equal(kept.length, 1);
  });
});
