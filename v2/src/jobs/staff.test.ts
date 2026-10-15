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

  it("intends ESP matching, plain text, and send-window fixes on ACTIVE campaigns", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          {
            id: 100,
            name: "Acme Outreach",
            status: "ACTIVE",
            clientId: 10,
            enableAiEspMatching: false,
            sendAsPlainText: false,
            trackSettings: [],
            timezone: "America/Chicago",
            daysOfTheWeek: [1, 2, 3, 4, 5],
            startHour: "09:00",
            endHour: "18:00",
          },
        ],
        accounts: [],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      sequences: [{ campaignId: 100, body: "<div>Hi there</div> %signature%" }],
      runQa: false,
    });
    assert.ok(result.findings.some((f) => f.kind === "esp_matching"));
    assert.ok(result.findings.some((f) => f.kind === "plain_text"));
    assert.ok(result.findings.some((f) => f.kind === "html_body"));
    assert.ok(result.findings.some((f) => f.kind === "send_window"));
    assert.ok(result.intended.some((a) => a.kind === "settings_write" && a.shadowed));
    assert.ok(result.intended.some((a) => a.kind === "schedule_write" && a.payload.reason === "send_window"));
    assert.ok(result.intended.some((a) => a.kind === "sequence_write" && a.payload.reason === "plain_text_html"));
  });

  it("fills a Deep Roots POC campaign to 60 without a POD stamp", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const spare = account({
      id: 2,
      email: "spare@pool.info",
      clientId: 597783,
      campaignIds: [],
      tags: [],
    });
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          {
            id: 200,
            name: "Deep Roots | Owners",
            status: "DRAFTED",
            clientId: 597783,
          },
        ],
        accounts: [spare],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    const attach = result.intended.find((a) => a.kind === "attach");
    assert.ok(attach);
    assert.equal(attach?.payload.reason, "poc_fill");
    assert.equal(attach?.payload.tag, "POC");
    assert.equal(attach?.payload.noPod, true);
    assert.ok(result.findings.some((f) => f.kind === "understaffed"));
  });

  it("refuses an off-week locked POD seat on a POC fill", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const { onWeekPod } = await import("../lib/staffable.js");
    const week = onWeekPod();
    const off = week === "A" ? "POD-B" : "POD-A";
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          {
            id: 200,
            name: "Deep Roots | Owners",
            status: "ACTIVE",
            clientId: 597783,
          },
        ],
        accounts: [
          account({
            id: 2,
            email: "off@pool.info",
            clientId: 597783,
            campaignIds: [],
            tags: [off],
          }),
        ],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.ok(!result.intended.some((a) => a.kind === "attach" && a.email === "off@pool.info"));
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
