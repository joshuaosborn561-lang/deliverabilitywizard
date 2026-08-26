import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
  extractSignatureLines,
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

  it("flags empty, one-line, and foreign signatures against the two-line rule", () => {
    const brands = ["Goliath Cybersecurity", "Roofs by Peterson"];
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Leila Sanchez",
        signature: "",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: brands,
      }),
      "has no signature (want First Last / client brand)",
    );
    assert.match(
      mailboxSignatureMismatch({
        fromName: "Leila Sanchez",
        signature: "Leila Sanchez",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: brands,
      }) ?? "",
      /want Leila Sanchez \/ Goliath Cybersecurity/,
    );
    assert.match(
      mailboxSignatureMismatch({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nRoofs by Peterson",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: brands,
      }) ?? "",
      /Roofs by Peterson/,
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Aarav Sanchez",
        signature: "<div>Aarav Sanchez</div><div>Goliath Cybersecurity</div>",
        clientBrand: "Goliath Cybersecurity",
        otherClientBrands: brands,
      }),
      null,
    );
  });

  it("strips person suffix from client display names", () => {
    assert.equal(
      brandFromClientDisplayName("Bolder Cyber Partners (Mike Trpkosh)"),
      "Bolder Cyber Partners",
    );
  });
});
