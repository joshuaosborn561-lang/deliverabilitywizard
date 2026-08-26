import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPods } from "./pods.js";
import { isoWeekNumberNy } from "./restCohort.js";

function state(emails: string[] = []) {
  const set = new Set(emails);
  return {
    getPoolMailbox: (email: string) =>
      set.has(email.toLowerCase())
        ? ({ email, status: "assigned" } as never)
        : undefined,
  };
}

describe("pods", () => {
  it("splits one client's inboxes A/B and keeps generics off that split", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const pods = buildPods({
      now,
      config: {
        extraGenericMailboxes: ["harmony norris"],
        extraGenericDomains: ["crosslaunchco.com"],
      },
      state: state(["spare@crosslaunchco.com"]),
      isolation: {
        emails: new Set(["lab@iso.test"]),
        domain: "iso.test",
      },
      accounts: [
        {
          accountId: 1,
          email: "a@client.com",
          clientId: 9,
          clientName: "Acme",
          onActiveCampaign: true,
          resting: false,
        },
        {
          accountId: 2,
          email: "b@client.com",
          clientId: 9,
          clientName: "Acme",
          onActiveCampaign: true,
          resting: false,
        },
        {
          accountId: 3,
          email: "spare@crosslaunchco.com",
          clientId: 9,
          clientName: "Acme",
          fromName: "Harmony Norris",
          onActiveCampaign: true,
          resting: false,
        },
        {
          accountId: 4,
          email: "sit@crosslaunchco.com",
          clientId: 9,
          clientName: "Acme",
          onActiveCampaign: false,
          resting: true,
        },
        {
          accountId: 5,
          email: "lab@iso.test",
          clientId: null,
          clientName: "lab",
          onActiveCampaign: false,
          resting: false,
        },
      ],
    });

    const clientPods = pods.filter((pod) => pod.pool === "A" || pod.pool === "B");
    assert.equal(clientPods.length, 2);
    const clientEmails = clientPods.flatMap((pod) =>
      pod.mailboxes.map((mailbox) => mailbox.email),
    );
    assert.deepEqual(clientEmails.sort(), ["a@client.com", "b@client.com"]);
    const generic = pods.find((pod) => pod.pool === "generic_sending");
    assert.ok(generic);
    assert.deepEqual(
      generic.mailboxes.map((mailbox) => mailbox.email),
      ["spare@crosslaunchco.com"],
    );
    const sitting = pods.find((pod) => pod.pool === "generic_resting");
    assert.ok(sitting);
    assert.equal(
      pods.some((pod) =>
        pod.mailboxes.some((mailbox) => mailbox.email.endsWith("@iso.test")),
      ),
      false,
    );
    assert.ok(Number.isInteger(isoWeekNumberNy(now)));
  });
});
