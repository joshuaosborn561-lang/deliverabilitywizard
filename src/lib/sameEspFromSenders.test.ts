import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferSenderEspFromSeedDetails,
  sameEspProvidersFromSenderReport,
} from "./sameEspFromSenders.js";

const seed = (opts: { folder: string; seed: "gmail" | "outlook"; sender: "google" | "microsoft" }) => ({
  email: opts.seed === "gmail" ? "seed@gmail.com" : "seed@outlook.com",
  reply: {
    mail_folder: opts.folder,
    rdns_result: {
      rdns: opts.seed === "gmail" ? "mail-sor-f41.google.com" : "mail-x.inbound.protection.outlook.com",
    },
    spf_result: {
      spf:
        (opts.seed === "gmail" ? "google.com" : "protection.outlook.com") +
        ": domain of a@x.com designates " +
        (opts.sender === "google" ? "209.85.220.41" : "2a01:111:f403:c409::2") +
        " as permitted sender",
    },
    dkim_result: {
      dkim: `dkim=pass header.i=@x.com header.s=${opts.sender === "google" ? "google" : "selector1"}`,
    },
  },
});

describe("sameEspFromSenders", () => {
  it("infers sender ESP from DKIM selector or SPF IP", () => {
    assert.equal(inferSenderEspFromSeedDetails([seed({ folder: "Inbox", seed: "outlook", sender: "google" })]), "google");
    assert.equal(inferSenderEspFromSeedDetails([seed({ folder: "Inbox", seed: "gmail", sender: "microsoft" })]), "microsoft");
    assert.equal(inferSenderEspFromSeedDetails([{ reply: {} }]), undefined);
  });

  it("scores Google senders only against Gmail seeds (cross-ESP spam ignored)", () => {
    const details = [
      ...Array.from({ length: 4 }, () => seed({ folder: "Inbox", seed: "gmail", sender: "google" })),
      ...Array.from({ length: 4 }, () => seed({ folder: "Spam", seed: "outlook", sender: "google" })),
    ];
    const providers = sameEspProvidersFromSenderReport([{ email: "a@x.com", details }]);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.inboxPercent, 100);
  });

  it("drops a family below the sample floor", () => {
    const details = [seed({ folder: "Spam", seed: "outlook", sender: "microsoft" })];
    assert.deepEqual(sameEspProvidersFromSenderReport({ result: [{ email: "b@x.com", details }] }), []);
  });
});
