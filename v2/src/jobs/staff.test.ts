import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";
import { runStaffTick } from "./staff.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

function account(partial: Partial<SlimAccount> & Pick<SlimAccount, "id" | "email">): SlimAccount {
  return {
    fromName: "Ada Lovelace",
    clientId: 10,
    campaignIds: [100],
    tags: ["POD-A"],
    smtpOk: true,
    imapOk: true,
    messagePerDay: 30,
    warmupBlocked: false,
    createdAt: "2020-01-01T00:00:00.000Z",
    warmupStartedAt: "2020-01-01T00:00:00.000Z",
    signature: "Ada Lovelace\nAcme",
    ...partial,
  };
}

describe("staff tick", () => {
  it("peels a living canary off a live campaign and logs detach without writing", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const campaign: SlimCampaign = {
      id: 100,
      name: "Acme Outreach",
      status: "ACTIVE",
      clientId: 10,
    };
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [campaign],
        accounts: [
          account({
            id: 1,
            email: "living@canary.test",
            tags: ["CANARY", "POD-A"],
          }),
        ],
      },
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
    });
    assert.ok(result.findings.some((f) => f.kind === "canary_on_live"));
    assert.ok(result.intended.some((a) => a.kind === "detach" && a.shadowed));
  });

  it("skips CALLER FOLLOW-UP campaigns", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          {
            id: 4085158,
            name: "Gabe Calls | SalesGlider",
            status: "ACTIVE",
            clientId: 345263,
          },
        ],
        accounts: [],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.intended.length, 0);
  });
});
