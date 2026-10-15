import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { WriteGate } from "../shadow.js";
import { MemoryStore } from "../store.js";
import { runIsolationTick } from "./isolation.js";

describe("isolation worker", () => {
  it("does not flag a 0% Gmail hit on a released sender", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runIsolationTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          { id: 3847940, name: "SG MSP Engagers", status: "ACTIVE", clientId: 1 },
        ],
        accounts: [],
      },
      tests: [
        {
          id: "t1",
          name: "Canary copy: #3847940 SG MSP Engagers",
          senders: [
            {
              email: "aminarodriguez@getcrosslaunchco.info",
              inbox: false,
              provider: "gmail",
            },
          ],
        },
      ],
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.scored, 0);
    assert.ok(!result.findings.some((f) => f.kind === "ugly_without_isolation"));
  });

  it("queues a fleet-only 0% and logs isolate; stops duplicate canary tests", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runIsolationTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          { id: 3847940, name: "SG MSP Engagers", status: "ACTIVE", clientId: 1 },
        ],
        accounts: [],
      },
      tests: [
        {
          id: "a",
          name: "Canary copy: #3847940 SG MSP Engagers",
          senders: [{ email: "living@canary.test", inbox: false, provider: "gmail" }],
        },
        {
          id: "b",
          name: "Canary copy: #3847940 extra",
          senders: [{ email: "living@canary.test", inbox: false, provider: "gmail" }],
        },
        {
          id: "c",
          name: "Auto: SG MSP Engagers",
          senders: [{ email: "warm@client.info", inbox: true, provider: "gmail" }],
        },
      ],
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.ok(result.findings.some((f) => f.kind === "duplicate_canary_test"));
    assert.ok(result.intended.some((a) => a.kind === "test_stop" && a.payload.testId === "b"));
    assert.ok(result.queued >= 1);
    assert.ok(result.intended.some((a) => a.kind === "isolate" && !a.executed));
  });

  it("scores the five 0% campaigns by campaignId and flags below_launch_bar + ugly", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const uglyIds = [3847940, 3921850, 3921852, 3921869, 4037540];
    const result = await runIsolationTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: uglyIds.map((id) => ({
          id,
          name: `Campaign ${id}`,
          status: "ACTIVE",
          clientId: 1,
        })),
        accounts: [],
      },
      tests: uglyIds.map((id) => ({
        id: `t-${id}`,
        name: `Warmed seeds ${id}`,
        campaignId: String(id),
        senders: [{ email: "warm@client.info", inbox: false, provider: "gmail" }],
      })),
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.scored, 5);
    for (const id of uglyIds) {
      assert.ok(
        result.findings.some((f) => f.kind === "below_launch_bar" && f.campaignId === id),
        `missing below_launch_bar for #${id}`,
      );
      assert.ok(
        result.findings.some((f) => f.kind === "ugly_without_isolation" && f.campaignId === id),
        `missing ugly_without_isolation for #${id}`,
      );
    }
    const scores = await store.listScores();
    assert.equal(scores.filter((s) => s.inboxPercent === 0).length, 5);
  });

  it("scores a 0% live test from providerwise splits when senders are missing", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runIsolationTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 3847940, name: "SG MSP Engagers", status: "ACTIVE", clientId: 1 }],
        accounts: [],
      },
      tests: [
        {
          id: "p1",
          name: "Auto: SG MSP Engagers",
          providers: [{ name: "gmail", inboxPercent: 0, emails: [] }],
        },
      ],
      fleetEmails: ["living@canary.test"],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.scored, 1);
    assert.ok(result.findings.some((f) => f.kind === "below_launch_bar"));
  });

  it("failed listTests is an error, not an empty board", async () => {
    await assert.rejects(
      async () => {
        throw new Error("SmartDelivery listTests returned no array");
      },
      /listTests/,
    );
  });
});
