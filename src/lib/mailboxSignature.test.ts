import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
  extractSignatureLines,
  isSameBrand,
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
        otherClientBrands: ["Bolder Cyber Partners", "TechEvolution"],
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

  it("strips person suffix from client display names", () => {
    assert.equal(
      brandFromClientDisplayName("Bolder Cyber Partners (Mike Trpkosh)"),
      "Bolder Cyber Partners",
    );
  });

  it("treats acronyms and longer legal names as the same brand", () => {
    assert.equal(isSameBrand("MSRS", "Mid-South Roof Systems"), true);
    assert.equal(isSameBrand("Bolder Cyber Partners", "Bolder Cyber Partners"), true);
    assert.equal(isSameBrand("TechEvolution", "Bolder Cyber Partners"), false);
  });

  it("rewrites a second line that belongs to a different client", () => {
    assert.equal(
      desiredMailboxSignature({
        fromName: "Harmony Norris",
        signature: "Harmony Norris\nTechEvolution",
        clientBrand: "Bolder Cyber Partners",
        otherClientBrands: ["TechEvolution", "SalesGlider", "MSRS"],
      }),
      "Harmony Norris\nBolder Cyber Partners",
    );
  });
});
