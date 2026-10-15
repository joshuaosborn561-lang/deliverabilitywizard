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

  it("does not flag unread ESP/plain/window settings as a blanket miss", async () => {
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
          },
        ],
        accounts: [],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.findings.filter((f) => f.kind === "esp_matching").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "plain_text").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "send_window").length, 0);
  });

  it("does not flag live-shaped ACTIVE campaigns that already match canon settings", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [
          {
            id: 3847940,
            name: "SG MSP Engagers",
            status: "ACTIVE",
            clientId: 1,
            enableAiEspMatching: true,
            sendAsPlainText: true,
            trackSettings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
            timezone: "America/New_York",
            daysOfTheWeek: [1, 2, 3, 4],
            startHour: "08:00",
            endHour: "19:00",
            minTimeBtwnEmails: 10,
          },
        ],
        accounts: [],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.findings.filter((f) => f.kind === "esp_matching").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "plain_text").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "send_window").length, 0);
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

  it("purges stale pending attaches so the next tick caps at the real deficit", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    for (let i = 0; i < 200; i += 1) {
      store.intended.push({
        kind: "attach",
        campaignId: 300,
        accountId: 1000 + i,
        email: `old${i}@pool.info`,
        payload: { reason: "min40_floor" },
        executed: false,
        shadowed: true,
        writeEnabled: false,
      });
    }
    const purged = await store.purgePendingIntents("attach");
    assert.equal(purged, 200);
    const { onWeekPod } = await import("../lib/staffable.js");
    const week = onWeekPod();
    const pod = week === "A" ? "POD-A" : "POD-B";
    const members = Array.from({ length: 5 }, (_, i) =>
      account({
        id: i + 1,
        email: `n${i}@techevolution.info`,
        clientId: 521881,
        campaignIds: [300],
        tags: [pod, "type:google"],
      }),
    );
    const spares = Array.from({ length: 40 }, (_, i) =>
      account({
        id: 100 + i,
        email: `spare${i}@techevolution.info`,
        clientId: 521881,
        campaignIds: [],
        tags: [pod, "type:google"],
      }),
    );
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 300, name: "TechEvo | Owners", status: "ACTIVE", clientId: 521881 }],
        accounts: [...members, ...spares],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.intended.filter((a) => a.kind === "attach").length, 25);
  });

  it("intends only the deficit to the floor and does not re-log an identical pending attach", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const { onWeekPod } = await import("../lib/staffable.js");
    const week = onWeekPod();
    const pod = week === "A" ? "POD-A" : "POD-B";
    const members = Array.from({ length: 5 }, (_, i) =>
      account({
        id: i + 1,
        email: `n${i}@techevolution.info`,
        clientId: 521881,
        campaignIds: [300],
        tags: [pod, "type:google"],
      }),
    );
    const spares = Array.from({ length: 40 }, (_, i) =>
      account({
        id: 100 + i,
        email: `spare${i}@techevolution.info`,
        clientId: 521881,
        campaignIds: [],
        tags: [pod, "type:google"],
      }),
    );
    const book = {
      fetchedAt: new Date().toISOString(),
      campaigns: [
        { id: 300, name: "TechEvo | Owners", status: "ACTIVE" as const, clientId: 521881 },
      ],
      accounts: [...members, ...spares],
    };
    const first = await runStaffTick({
      book,
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    const attaches = first.intended.filter((a) => a.kind === "attach" && a.payload.reason === "min40_floor");
    assert.equal(attaches.length, 25, "TechEvo floor 30 minus 5 staffable");
    assert.ok(first.findings.some((f) => f.kind === "understaffed"));
    const second = await runStaffTick({
      book,
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(
      second.intended.filter((a) => a.kind === "attach" && a.payload.reason === "min40_floor").length,
      0,
    );
    assert.equal((await store.listIntended()).filter((a) => a.kind === "attach").length, 25);
  });

  it("does not invent 40 attaches per campaign when campaign_ids are empty", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const campaigns = Array.from({ length: 8 }, (_, i) => ({
      id: 1000 + i,
      name: `Client ${i} | A`,
      status: "ACTIVE" as const,
      clientId: 10,
    }));
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns,
        accounts: Array.from({ length: 50 }, (_, i) =>
          account({
            id: i + 1,
            email: `a${i}@acme.info`,
            campaignIds: [],
            tags: [],
          }),
        ),
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.equal(result.intended.filter((a) => a.kind === "attach").length, 0);
    assert.equal(result.findings.filter((f) => f.kind === "understaffed").length, 0);
  });

  it("flags generic_idle when named on-week staffable already meets the floor", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const { onWeekPod } = await import("../lib/staffable.js");
    const week = onWeekPod();
    const pod = week === "A" ? "POD-A" : "POD-B";
    const named = Array.from({ length: 40 }, (_, i) =>
      account({
        id: i + 1,
        email: `n${i}@acme.info`,
        campaignIds: [100],
        tags: [pod],
      }),
    );
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 100, name: "Acme Outreach", status: "ACTIVE", clientId: 10 }],
        accounts: [
          ...named,
          account({
            id: 99,
            email: "idle@pool.info",
            campaignIds: [100],
            tags: ["GENERIC", pod],
          }),
        ],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      runQa: false,
    });
    assert.ok(result.findings.some((f) => f.kind === "generic_idle" && f.email === "idle@pool.info"));
  });

  it("QA records missing_signature_tag when the sequence has no signature tag", async () => {
    const store = new MemoryStore();
    const gate = new WriteGate(loadConfig({} as NodeJS.ProcessEnv), store);
    const result = await runStaffTick({
      book: {
        fetchedAt: new Date().toISOString(),
        campaigns: [{ id: 100, name: "Acme Outreach", status: "ACTIVE", clientId: 10 }],
        accounts: [],
      },
      fleetEmails: [],
      gate,
      store,
      config: loadConfig({} as NodeJS.ProcessEnv),
      sequences: [{ campaignId: 100, body: "Hi there, just checking in." }],
    });
    assert.ok(result.findings.some((f) => f.kind === "missing_signature_tag"));
    const runs = await store.listQaRuns();
    assert.ok(runs.some((r) => r.status === "completed"));
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
