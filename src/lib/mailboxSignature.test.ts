import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
  extractSignatureLines,
  formatMailboxSignatureMismatch,
  mailboxSignatureMismatch,
} from "./mailboxSignature.js";

describe("mailboxSignature", () => {
  it("keeps plain two-line signatures", () => {
    assert.deepEqual(
      extractSignatureLines("Nathaniel Cartwright\nBolder Cyber Partners"),
      ["Nathaniel Cartwright", "Bolder Cyber Partners"],
    );
  });

  it("flattens HTML div pairs to lines", () => {
    assert.deepEqual(
      extractSignatureLines(
        "<div>Harmony Norris</div><div>TechEvolution</div>",
      ),
      ["Harmony Norris", "TechEvolution"],
    );
  });

  it("builds Name\\nBrand and preserves richer existing brand lines", () => {
    assert.equal(
      desiredMailboxSignature({
        fromName: "Katya Sanchez",
        signature: "<div>Katya Sanchez</div><div>Mid-South Roof Systems</div>",
        clientBrand: "MSRS",
      }),
      "Katya Sanchez\nMid-South Roof Systems",
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Joshua Osborn",
        signature: "",
        clientBrand: "SalesGlider",
      }),
      "Joshua Osborn\nSalesGlider",
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Amira Costa",
        signature: "",
        clientBrand: "",
      }),
      null,
    );
  });

  it("rewrites a leftover other-client brand (D74)", () => {
    assert.equal(
      desiredMailboxSignature({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nRoofs by Peterson",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: [
          "Roofs by Peterson",
          "Goliath Cybersecurity",
          "Bolder Cyber Partners",
        ],
      }),
      "Aarav Sanchez\nGoliath Cybersecurity",
    );
  });

  it("strips person suffix from client display names", () => {
    assert.equal(
      brandFromClientDisplayName("Bolder Cyber Partners (Mike Trpkosh)"),
      "Bolder Cyber Partners",
    );
  });

  it("audits against First Last / client brand (D124)", () => {
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nGoliath Cybersecurity",
        clientBrand: "Goliath Cybersecurity",
      }),
      null,
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Leila Sanchez",
        signature: "",
        clientBrand: "Goliath Cybersecurity",
      })?.reason,
      "empty",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Nathaniel Cartwright",
        signature: "Nathaniel Cartwright Bolder Cyber Partners",
        clientBrand: "Bolder Cyber Partners",
      })?.reason,
      "name",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nSalesGlider Growth Partners",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: [
          "SalesGlider Growth Partners",
          "Goliath Cybersecurity",
        ],
      })?.reason,
      "brand",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Katya Sanchez",
        signature: "<div>Katya Sanchez</div><div>Mid-South Roof Systems</div>",
        clientBrand: "MSRS",
      })?.reason,
      "format",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nRoofs by Peterson",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: ["Roofs by Peterson", "Goliath Cybersecurity"],
      })?.reason,
      "brand",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Ada Pool",
        signature: "Someone Else\nSalesGlider",
        clientBrand: "SalesGlider",
      })?.reason,
      "name",
    );
    assert.match(
      formatMailboxSignatureMismatch("leila@goliath.com", {
        expected: "Leila Sanchez\nGoliath Cybersecurity",
        actual: "",
        reason: "empty",
      }),
      /leila@goliath.com empty — have \(empty\); want Leila Sanchez \/ Goliath Cybersecurity/,
    );
  });
});
