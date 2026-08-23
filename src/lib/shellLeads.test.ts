import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emailsFromLeadList,
  pickShellLeadEmails,
  shellLeadRecords,
} from "./shellLeads.js";

describe("pickShellLeadEmails", () => {
  it("takes two addresses per pre-warmed domain and keeps existing picks", () => {
    const picked = pickShellLeadEmails({
      extraGenericDomains: [
        "crosslaunchco.com",
        "crossscaleco.com",
        "cleartechco.com",
      ],
      candidates: [
        "z@crosslaunchco.com",
        "a@crosslaunchco.com",
        "b@crosslaunchco.com",
        "one@crossscaleco.com",
        "two@crossscaleco.com",
        "skip@client.com",
        "sit@cleartechco.com",
      ],
      existing: ["b@crosslaunchco.com"],
    });
    assert.deepEqual(picked, [
      "b@crosslaunchco.com",
      "sit@cleartechco.com",
      "a@crosslaunchco.com",
      "one@crossscaleco.com",
      "two@crossscaleco.com",
    ]);
  });

  it("ignores addresses outside the pre-warmed fleets", () => {
    assert.deepEqual(
      pickShellLeadEmails({
        extraGenericDomains: ["crosslaunchco.com"],
        candidates: ["x@client.com", "y@other.info"],
      }),
      [],
    );
  });
});

describe("shellLeadRecords", () => {
  it("splits the local part into a first and last name", () => {
    assert.deepEqual(shellLeadRecords(["harmony.norris@crosslaunchco.com"]), [
      {
        email: "harmony.norris@crosslaunchco.com",
        first_name: "Harmony",
        last_name: "Norris",
      },
    ]);
  });
});

describe("emailsFromLeadList", () => {
  it("reads nested Smartlead lead envelopes", () => {
    assert.deepEqual(
      emailsFromLeadList({
        data: [{ lead: { email: "A@crosslaunchco.com" } }, { email: "b@x.com" }],
      }),
      ["a@crosslaunchco.com", "b@x.com"],
    );
  });
});
