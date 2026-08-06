import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandFromClientDisplayName,
  desiredMailboxSignature,
  extractSignatureLines,
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

  it("strips person suffix from client display names", () => {
    assert.equal(
      brandFromClientDisplayName("Bolder Cyber Partners (Mike Trpkosh)"),
      "Bolder Cyber Partners",
    );
  });
});
