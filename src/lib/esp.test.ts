import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSenderEspFamily } from "./esp.js";

describe("normalizeSenderEspFamily (D301)", () => {
  it("still maps GMAIL / OUTLOOK type strings", () => {
    assert.equal(normalizeSenderEspFamily("GMAIL"), "google");
    assert.equal(normalizeSenderEspFamily("OUTLOOK"), "microsoft");
    assert.equal(normalizeSenderEspFamily("SMTP"), "other");
  });

  it("classifies SMTP on smtp.gmail.com as Gmail", () => {
    assert.equal(
      normalizeSenderEspFamily({
        type: "SMTP",
        smtp_host: "smtp.gmail.com",
      }),
      "google",
    );
  });

  it("classifies type:google as Gmail even when type is SMTP", () => {
    assert.equal(
      normalizeSenderEspFamily({
        type: "SMTP",
        tags: [{ tag_name: "type:google" }],
      }),
      "google",
    );
  });

  it("classifies type:m365 and type:azure as Microsoft", () => {
    assert.equal(
      normalizeSenderEspFamily({
        type: "SMTP",
        tags: [{ tag_name: "type:m365" }],
      }),
      "microsoft",
    );
    assert.equal(
      normalizeSenderEspFamily({
        type: "SMTP",
        tags: [{ tag_name: "type:azure" }],
      }),
      "microsoft",
    );
  });
});
