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

  it("signs a JEREMY-CIOTOLA seat as the name alone (D328)", () => {
    assert.equal(
      desiredMailboxSignature({
        fromName: "Jeremy Ciotola",
        signature: "Jeremy Ciotola\nSalesGlider",
        clientBrand: "SalesGlider",
        otherClientBrands: ["SalesGlider", "Insight", "Emcor"],
      }),
      "Jeremy Ciotola",
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "J. Ciotola",
        signature: "",
        clientBrand: "SalesGlider",
        ciotolaSeat: true,
      }),
      "Jeremy Ciotola",
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Jeremy Ciotola",
        signature: "Jeremy Ciotola",
        clientBrand: "SalesGlider",
      }),
      null,
    );
    assert.match(
      mailboxSignatureMismatch({
        fromName: "Jeremy Ciotola",
        signature: "Jeremy Ciotola\nSalesGlider",
        clientBrand: "SalesGlider",
      }) ?? "",
      /want Jeremy Ciotola\)$/,
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
        fromName: "Alicia Sheridan",
        signature: "Alicia Sheridan\nEmcor Mesa Energy Systems",
        clientBrand: "Emcor",
      }),
      "Alicia Sheridan\nEmcor Mesa Energy Systems",
    );
  });

  it("keeps the three-line Josh Osborn signature on an Insight seat (D329)", () => {
    const canon = "Josh Osborn\nStrategic Account Executive\nInsight";
    assert.equal(
      desiredMailboxSignature({
        fromName: "Joshua Osborn",
        signature: canon,
        clientBrand: "SalesGlider",
        otherClientBrands: ["SalesGlider", "Insight", "Emcor"],
        insightSeat: true,
      }),
      canon,
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Josh Osborn",
        signature: "Joshua Osborn\nStrategic Account Executive",
        clientBrand: "Insight",
        insightSeat: true,
      }),
      canon,
    );
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Joshua Osborn",
        signature: canon,
        clientBrand: "Insight",
        insightSeat: true,
      }),
      null,
    );
    assert.match(
      mailboxSignatureMismatch({
        fromName: "Joshua Osborn",
        signature: "Joshua Osborn\nStrategic Account Executive",
        clientBrand: "Insight",
        insightSeat: true,
      }) ?? "",
      /want Josh Osborn \/ Strategic Account Executive \/ Insight/,
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Joshua Osborn",
        signature: canon,
        clientBrand: "SalesGlider",
      }),
      "Joshua Osborn\nStrategic Account Executive",
    );
    assert.equal(
      desiredMailboxSignature({
        fromName: "Owen Sanchez",
        signature: "",
        clientBrand: "Insight",
        insightSeat: true,
      }),
      "Owen Sanchez\nInsight",
    );
  });

  it("strips person suffix from client display names", () => {
    assert.equal(
      brandFromClientDisplayName("Bolder Cyber Partners (Mike Trpkosh)"),
      "Bolder Cyber Partners",
    );
  });
});
