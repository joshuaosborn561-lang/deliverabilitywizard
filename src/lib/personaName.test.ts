import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCompanySenderName,
  resolveSendIdentity,
  isPlaceholderPersonName,
  personaFromName,
  resolveSeatPersona,
} from "./personaName.js";
import {
  desiredMailboxSignature,
  mailboxSignatureMismatch,
} from "./mailboxSignature.js";

describe("real-persona rule — placeholder detection", () => {
  const placeholders = [
    "Pool User",
    "Pool",
    "User",
    "Generic Box",
    "Test",
    "Test Sender",
    "Canary Box",
    "",
    "   ",
    null,
    undefined,
    "wilhelmina",
    "N/A",
    "Admin Team",
    "Sample Mailbox",
    "Jane Unknown",
    "pool-user",
    "POOL  USER",
  ];
  for (const name of placeholders) {
    it(`flags ${JSON.stringify(name)}`, () => {
      assert.equal(isPlaceholderPersonName(name), true);
    });
  }

  it("flags the email local part used as the name", () => {
    assert.equal(
      isPlaceholderPersonName("wilhelm oldfield", "wilhelmoldfield@kendrickloft.info"),
      true,
    );
    assert.equal(
      isPlaceholderPersonName("Wilhelmina Oldfield", "wilhelmina@kendrickloft.info"),
      false,
    );
  });

  for (const name of ["Wilhelmina Oldfield", "Alicia Sheridan", "Joshua Osborn", "Mary-Jane O'Neil", "José Álvarez", "Ada Poole"]) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      assert.equal(isPlaceholderPersonName(name), false);
    });
  }

  it("personaFromName returns null, never a default, for a placeholder", () => {
    assert.equal(personaFromName("Pool User"), null);
    assert.equal(personaFromName(""), null);
    assert.deepEqual(personaFromName("Alicia Sheridan"), {
      firstName: "Alicia",
      lastName: "Sheridan",
    });
  });

  it("resolveSeatPersona: pool row first, live mailbox second, else null", () => {
    const email = "seat@example.info";
    assert.equal(
      resolveSeatPersona({
        email,
        pool: { firstName: "Pool", lastName: "User" },
        liveFromName: "Pool User",
      }),
      null,
    );
    assert.equal(resolveSeatPersona({ email, pool: null, liveFromName: null }), null);
    assert.equal(
      resolveSeatPersona({ email, pool: { firstName: "", lastName: "" }, liveFromName: "Alicia Sheridan" })
        ?.source,
      "live-mailbox",
    );
    assert.deepEqual(
      resolveSeatPersona({
        email,
        pool: { firstName: "Wilhelmina", lastName: "Oldfield" },
        liveFromName: "Pool User",
      }),
      { firstName: "Wilhelmina", lastName: "Oldfield", source: "pool-row" },
    );
  });
});

describe("real-persona rule — signature builder", () => {
  it("never builds a signature from a placeholder name", () => {
    assert.equal(
      desiredMailboxSignature({ fromName: "Pool User", clientBrand: "Emcor" }),
      null,
    );
    assert.equal(
      desiredMailboxSignature({ fromName: "Alicia Sheridan", clientBrand: "Emcor" }),
      "Alicia Sheridan\nEmcor",
    );
  });

  it("a placeholder-named mailbox is not 'in sync' by accident", () => {
    // Before the fix, "Pool User\nEmcor" matched from_name+brand exactly.
    assert.equal(
      desiredMailboxSignature({
        fromName: "Pool User",
        signature: "Pool User\nEmcor",
        clientBrand: "Emcor",
      }),
      null,
    );
  });

  it("mailboxSignatureMismatch stays quiet for real names that match", () => {
    assert.equal(
      mailboxSignatureMismatch({
        fromName: "Alicia Sheridan",
        signature: "Alicia Sheridan\nEmcor",
        clientBrand: "Emcor",
      }),
      null,
    );
  });
});

describe("real-persona rule — company fallback", () => {
  const email = "seat@example.info";
  it("persona -> 'First Last' + brand signature", () => {
    assert.deepEqual(
      resolveSendIdentity({
        email,
        pool: { firstName: "Alicia", lastName: "Sheridan" },
        clientBrand: "Emcor",
      }),
      {
        fromName: "Alicia Sheridan",
        signature: "Alicia Sheridan\nEmcor",
        firstName: "Alicia",
        lastName: "Sheridan",
        source: "pool-row",
      },
    );
  });
  it("no persona -> the company name as from_name, signature = company", () => {
    const id = resolveSendIdentity({
      email,
      pool: { firstName: "Pool", lastName: "User" },
      liveFromName: "Pool User",
      clientBrand: "Emcor",
    });
    assert.equal(id?.fromName, "Emcor");
    assert.equal(id?.signature, "Emcor");
    assert.equal(id?.source, "company");
  });
  it("no persona and no usable company name -> null (nothing real to send as)", () => {
    assert.equal(resolveSendIdentity({ email, clientBrand: "" }), null);
    assert.equal(resolveSendIdentity({ email, clientBrand: "574020" }), null);
  });
  it("a company-named mailbox signs with the company alone, not a mismatch", () => {
    assert.equal(isCompanySenderName("emcor", "Emcor"), true);
    assert.equal(
      desiredMailboxSignature({ fromName: "Emcor", clientBrand: "Emcor" }),
      "Emcor",
    );
    assert.equal(
      mailboxSignatureMismatch({ fromName: "Emcor", signature: "Emcor", clientBrand: "Emcor" }),
      null,
    );
  });
});
