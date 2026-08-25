import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findForeignBrand } from "./clientBrand.js";
import { missingSignatureTag, signatureHay } from "./signatureQa.js";

describe("signature QA (D74)", () => {
  it("flags a Peterson brand on a Goliath hay", () => {
    assert.equal(
      findForeignBrand(
        "Aarav Sanchez\nRoofs by Peterson",
        "Goliath Cybersecurity",
        ["Goliath Cybersecurity", "Roofs by Peterson", "Bolder Cyber Partners"],
      ),
      "Roofs by Peterson",
    );
  });

  it("does not flag the campaign's own brand", () => {
    assert.equal(
      findForeignBrand(
        "Aarav Sanchez\nGoliath Cybersecurity",
        "Goliath Cybersecurity",
        ["Goliath Cybersecurity", "Roofs by Peterson"],
      ),
      null,
    );
  });

  it("reads the rendered two-line signature", () => {
    assert.match(
      signatureHay({
        fromName: "Aarav Sanchez",
        signature: "Aarav Sanchez\nRoofs by Peterson",
      }),
      /Roofs by Peterson/,
    );
  });

  it("requires %signature% on a real step", () => {
    assert.equal(
      missingSignatureTag("<div>Sean, that offer's still open</div><div>Aarav Sanchez</div>"),
      true,
    );
    assert.equal(
      missingSignatureTag("<div>open to it?</div><div>%signature%</div>"),
      false,
    );
  });
});
