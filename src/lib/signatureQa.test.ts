import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findForeignBrand } from "./clientBrand.js";
import {
  appendSignatureTag,
  missingSignatureTag,
  sequencesForWrite,
  signatureHay,
} from "./signatureQa.js";

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

describe("one-click signature fix (D85)", () => {
  it("appends the tag to the variant missing it and changes nothing else", () => {
    const body = "<div>Sean, that offer's still open</div>";
    const { sequences, changed } = appendSignatureTag([
      {
        id: 1,
        seq_number: 1,
        sequence_variants: [
          { id: 11, variant_label: "A", subject: "hey", email_body: body },
          {
            id: 12,
            variant_label: "B",
            subject: "hey",
            email_body: "<div>open?</div><div>%signature%</div>",
          },
        ],
      },
    ]);
    assert.deepEqual(changed, ["step 1 A"]);
    assert.equal(
      sequences[0]!.sequence_variants![0]!.email_body,
      `${body}<br><br>%signature%`,
    );
    // The B variant already carries the tag — byte-for-byte untouched.
    assert.equal(
      sequences[0]!.sequence_variants![1]!.email_body,
      "<div>open?</div><div>%signature%</div>",
    );
    // Subjects are never edited.
    assert.equal(sequences[0]!.sequence_variants![0]!.subject, "hey");
  });

  it("fixes a bare sequence body and skips empty ones", () => {
    const { sequences, changed } = appendSignatureTag([
      { id: 1, seq_number: 1, email_body: "<div>quick one</div>" },
      { id: 2, seq_number: 2, email_body: "" },
    ]);
    assert.deepEqual(changed, ["step 1"]);
    assert.equal(
      sequences[0]!.email_body,
      "<div>quick one</div><br><br>%signature%",
    );
    assert.equal(sequences[1]!.email_body, "");
  });

  it("is append-only: the original copy survives verbatim", () => {
    const body = "<p>Line one</p><p>Aarav Sanchez, Goliath</p>";
    const { sequences } = appendSignatureTag([
      { id: 1, seq_number: 3, email_body: body },
    ]);
    assert.ok(sequences[0]!.email_body!.startsWith(body));
    assert.ok(sequences[0]!.email_body!.endsWith("%signature%"));
  });

  it("D101: sequence writes drop created_at so Smartlead accepts the POST", () => {
    const written = sequencesForWrite([
      {
        id: 1,
        seq_number: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        email_body: "<div>Hi</div><div>%signature%</div>",
        sequence_variants: [
          {
            id: 11,
            variant_label: "A",
            created_at: "2026-01-01T00:00:00.000Z",
            email_body: "<div>Hi</div><div>%signature%</div>",
          },
        ],
      },
    ]);
    assert.equal("created_at" in written[0]!, false);
    assert.equal("updated_at" in written[0]!, false);
    assert.equal("created_at" in (written[0]!.sequence_variants![0] as object), false);
    assert.equal(written[0]!.id, 1);
    assert.equal(written[0]!.email_body, "<div>Hi</div><div>%signature%</div>");
  });
});
